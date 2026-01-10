const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS Ayarları (Render.com ve Localhost için)
app.use(cors());

const io = new Server(server, {
    cors: {
        origin: "*", // Güvenlik için production'da spesifik domain girilebilir
        methods: ["GET", "POST"]
    }
});

// Statik dosyaları sun
app.use(express.static(path.join(__dirname, '.')));

// Oyun Durumu
const rooms = new Map();
const players = new Map();

// Yardımcı Fonksiyonlar
function generateRoomCode() {
    const chars = 'ACDEFGHJKLMNPQRSTUVWXYZ2345679'; // Okunabilirliği artırmak için I, O, B, 8, 1, 0 çıkarıldı
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const numbers = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const actions = ['skip', 'reverse', 'draw-two'];
    const wilds = ['wild', 'wild-draw-four'];
    
    const deck = [];
    
    colors.forEach(color => {
        deck.push({ color, value: '0', type: 'number' });
        numbers.slice(1).forEach(value => {
            deck.push({ color, value, type: 'number' });
            deck.push({ color, value, type: 'number' });
        });
        actions.forEach(type => {
            deck.push({ color, value: type, type });
            deck.push({ color, value: type, type });
        });
    });
    
    wilds.forEach(type => {
        for (let i = 0; i < 4; i++) {
            deck.push({ color: 'black', value: type, type });
        }
    });
    
    return shuffleArray(deck);
}

function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function dealCards(deck, numPlayers) {
    const hands = [];
    for (let i = 0; i < numPlayers; i++) {
        hands.push(deck.splice(0, 7));
    }
    return hands;
}

// Socket.io Olayları
io.on('connection', (socket) => {
    console.log('🔌 [BAĞLANTI]', socket.id);
    
    players.set(socket.id, {
        socketId: socket.id,
        roomId: null,
        nickname: 'Yabancı',
        avatar: '💀',
        score: 0,
        isReady: false,
        isHost: false
    });
    
    socket.emit('welcome', { message: 'HIGH STAKES Protokolüne Hoş Geldin.' });
    
    // Oda Listesi
    socket.on('getRooms', () => {
        const roomList = Array.from(rooms.values()).map(r => ({
            id: r.id,
            name: r.name,
            playerCount: r.players.length,
            maxPlayers: 4,
            gameState: r.gameState
        }));
        socket.emit('roomList', roomList);
    });
    
    // Oda Oluştur
    socket.on('createRoom', (data, callback) => {
        const player = players.get(socket.id);
        if (!player) return callback({ success: false, error: 'Kimlik doğrulama hatası.' });
        
        const roomId = generateRoomCode();
        const room = {
            id: roomId,
            name: data.roomName || `MASA #${roomId.substring(0,3)}`,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            currentPlayerIndex: 0,
            direction: 1,
            created: new Date()
        };
        
        player.nickname = data.nickname || 'Yabancı';
        player.avatar = data.avatar || '💀';
        player.roomId = roomId;
        player.isHost = true;
        player.isReady = true; // Host otomatik hazır
        
        room.players.push({ ...player, hand: [], cardCount: 0 });
        rooms.set(roomId, room);
        
        socket.join(roomId);
        console.log(`🏗️ [ODA] ${roomId} oluşturuldu.`);
        
        io.to(roomId).emit('roomUpdate', { ...room, deck: null }); // Desteyi gizle
        callback({ success: true, roomId });
    });

    // Odaya Katıl
    socket.on('joinRoom', (data, callback) => {
        const player = players.get(socket.id);
        const room = rooms.get(data.roomId);
        
        if (!room) return callback({ success: false, error: 'Oda bulunamadı veya kapatıldı.' });
        if (room.players.length >= 4) return callback({ success: false, error: 'Masa dolu.' });
        if (room.gameState !== 'LOBBY') return callback({ success: false, error: 'Oyun çoktan başladı.' });
        
        player.nickname = data.nickname || 'Yabancı';
        player.avatar = data.avatar || '💀';
        player.roomId = room.id;
        player.isHost = false;
        player.isReady = false;
        
        room.players.push({ ...player, hand: [], cardCount: 0 });
        socket.join(room.id);
        
        io.to(room.id).emit('roomUpdate', { ...room, deck: null });
        callback({ success: true });
    });

    // Hazır Ol
    socket.on('toggleReady', () => {
        const player = players.get(socket.id);
        if (!player?.roomId) return;
        const room = rooms.get(player.roomId);
        
        const roomPlayer = room.players.find(p => p.socketId === socket.id);
        if (roomPlayer) {
            roomPlayer.isReady = !roomPlayer.isReady;
            io.to(room.id).emit('roomUpdate', { ...room, deck: null });
        }
    });

    // Oyunu Başlat
    socket.on('startGame', () => {
        const player = players.get(socket.id);
        if (!player?.roomId) return;
        const room = rooms.get(player.roomId);
        
        if (player.isHost && room.players.length >= 2 && room.players.every(p => p.isReady)) {
            room.gameState = 'PLAYING';
            room.deck = createDeck();
            room.discardPile = [];
            
            // İlk kart (siyah olmamalı)
            let firstCard;
            do {
                firstCard = room.deck.pop();
                if(firstCard.color === 'black') room.deck.unshift(firstCard); // Alta koy
            } while (firstCard.color === 'black');
            
            room.discardPile.push(firstCard);
            room.topCard = firstCard;
            
            // Kartları dağıt
            const hands = dealCards(room.deck, room.players.length);
            room.players.forEach((p, i) => {
                p.hand = hands[i];
                p.cardCount = p.hand.length;
                p.isCurrentTurn = (i === 0);
            });
            
            room.currentPlayerIndex = 0;
            
            // Her oyuncuya kendi elini gönder
            room.players.forEach(p => {
                io.to(p.socketId).emit('gameStarted', {
                    hand: p.hand,
                    topCard: room.topCard,
                    players: room.players.map(pl => ({...pl, hand: null})), // Rakiplerin elini gizle
                    isMyTurn: p.isCurrentTurn
                });
            });
            
            io.to(room.id).emit('notification', { text: 'OYUN BAŞLADI. BOL ŞANS.', type: 'system' });
        }
    });

    // Kart Oyna
    socket.on('playCard', (data) => {
        const player = players.get(socket.id);
        if (!player?.roomId) return;
        const room = rooms.get(player.roomId);
        const roomPlayer = room.players.find(p => p.socketId === socket.id);
        
        if (!roomPlayer.isCurrentTurn) return;
        
        const card = roomPlayer.hand[data.cardIndex];
        
        // Geçerlilik Kontrolü
        const top = room.topCard;
        const currentDisplayColor = top.displayColor || top.color;
        
        let isValid = false;
        if (card.color === 'black') isValid = true;
        else if (card.color === currentDisplayColor) isValid = true;
        else if (card.value === top.value) isValid = true;
        
        if (isValid) {
            // Kartı elden çıkar
            roomPlayer.hand.splice(data.cardIndex, 1);
            roomPlayer.cardCount = roomPlayer.hand.length;
            
            // Renk seçimi (Wild için)
            if (card.color === 'black' && data.chosenColor) {
                card.displayColor = data.chosenColor;
            }
            
            room.discardPile.push(card);
            room.topCard = card;
            
            // Efekt Kontrolü
            let nextStep = 1;
            if (card.type === 'reverse') room.direction *= -1;
            if (card.type === 'skip') nextStep = 2;
            
            // +2 ve +4 Mantığı
            let drawCount = 0;
            if (card.value === 'draw-two') drawCount = 2;
            if (card.value === 'wild-draw-four') drawCount = 4;
            
            if (drawCount > 0) {
                const nextPlayerIndex = (room.currentPlayerIndex + (room.direction * 1) + room.players.length) % room.players.length;
                const victim = room.players[nextPlayerIndex];
                
                // Deste biterse
                if (room.deck.length < drawCount) {
                    const top = room.discardPile.pop();
                    room.deck = shuffleArray([...room.deck, ...room.discardPile]);
                    room.discardPile = [top];
                }
                
                for(let i=0; i<drawCount; i++) victim.hand.push(room.deck.pop());
                victim.cardCount = victim.hand.length;
                nextStep = 2; // Ceza yiyen oynayamaz
                
                io.to(victim.socketId).emit('shakeScreen'); // EKRAN SALLAMA EFEKTİ
            }

            // Sıra Değiştir
            room.currentPlayerIndex = (room.currentPlayerIndex + (room.direction * nextStep) + room.players.length) % room.players.length;
            
            // UNO Kontrolü (Basit - Otomatik uyarı)
            if (roomPlayer.cardCount === 1) {
                io.to(room.id).emit('notification', { text: `${roomPlayer.nickname} "TEK KART!" DEDİ`, type: 'warning' });
            }
            
            // KAZANMA DURUMU
            if (roomPlayer.cardCount === 0) {
                io.to(room.id).emit('gameOver', { winner: roomPlayer });
                room.gameState = 'LOBBY'; // Reset
                room.players.forEach(p => { p.isReady = false; p.hand = []; p.cardCount = 0; });
                return; // Buradan çık
            }
            
            // Durum Güncelleme
            room.players.forEach((p, i) => {
                p.isCurrentTurn = (i === room.currentPlayerIndex);
            });
            
            updateGameState(room);
        }
    });
    
    // Kart Çek
    socket.on('drawCard', () => {
        const player = players.get(socket.id);
        const room = rooms.get(player.roomId);
        const roomPlayer = room.players.find(p => p.socketId === socket.id);
        
        if (!roomPlayer.isCurrentTurn) return;
        
        if (room.deck.length === 0) {
            const top = room.discardPile.pop();
            room.deck = shuffleArray(room.discardPile);
            room.discardPile = [top];
        }
        
        const newCard = room.deck.pop();
        roomPlayer.hand.push(newCard);
        roomPlayer.cardCount = roomPlayer.hand.length;
        
        // Pas geç (Otomatik olarak bir sonraki oyuncuya geçer - Hızlı oyun için)
        room.currentPlayerIndex = (room.currentPlayerIndex + room.direction + room.players.length) % room.players.length;
        
        room.players.forEach((p, i) => { p.isCurrentTurn = (i === room.currentPlayerIndex); });
        updateGameState(room);
    });

    // Ayrılma
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            const room = rooms.get(player.roomId);
            if(room) {
                room.players = room.players.filter(p => p.socketId !== socket.id);
                if (room.players.length === 0) {
                    rooms.delete(room.id);
                } else {
                    if (player.isHost) room.players[0].isHost = true; // Yeni host
                    io.to(room.id).emit('roomUpdate', { ...room, deck: null });
                }
            }
        }
        players.delete(socket.id);
    });
});

function updateGameState(room) {
    room.players.forEach(p => {
        io.to(p.socketId).emit('gameState', {
            hand: p.hand,
            topCard: room.topCard,
            players: room.players.map(pl => ({...pl, hand: null})),
            isMyTurn: p.isCurrentTurn
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`💀 HIGH STAKES sunucusu aktif: Port ${PORT}`);
});
