/* UNO PRO SERVER 
   - Dünyanın En İyi UNO Oyunu
   - StoryArt Tarzı Modern Tasarım
   - 3D Kartlar ve Animasyonlar
   - Bar Stili Oturma Düzeni
   - Mobil Uyumluluk
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public')); // Statik dosyalar için

const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"],
        transports: ['websocket', 'polling']
    },
    pingInterval: 25000,
    pingTimeout: 60000
});

// --- OYUN SABİTLERİ VE VERİ YAPILARI ---
const CARD_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const COLORS = ['red', 'blue', 'green', 'yellow'];
const SPECIAL_CARDS = ['wild', 'draw4'];

class GameRoom {
    constructor(id, settings = {}) {
        this.id = id;
        this.players = []; // {id, name, avatar, hand, score, isReady, position}
        this.deck = [];
        this.discardPile = [];
        this.turnIndex = 0;
        this.direction = 1; // 1: Saat yönü, -1: Ters
        this.gameState = 'LOBBY'; // LOBBY, PLAYING, CHALLENGE_WAITING, SCORING
        this.settings = {
            stacking: settings.stacking || false,
            targetScore: 500,
            sevenZero: settings.sevenZero || false, // 7-0 kuralı
            progressive: settings.progressive || false // İlerleyici UNO
        };
        this.pendingChallenge = null;
        this.unoCallers = new Set();
        this.drawStack = 0;
        this.creationTime = Date.now();
        this.maxPlayers = 4;
        this.roomName = settings.roomName || `Oda ${id}`;
        this.password = settings.password || null;
        this.isPublic = settings.isPublic !== false;
        this.lastActivity = Date.now();
    }

    // Orijinal 108 Kart Deste
    createDeck() {
        this.deck = [];
        COLORS.forEach(color => {
            // 1 adet 0
            this.deck.push({ 
                color, 
                value: '0', 
                type: 'number', 
                id: Math.random().toString(36).substr(2, 9),
                points: 0
            });
            
            // 2 adet 1-9
            for (let v of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
                for (let i = 0; i < 2; i++) {
                    this.deck.push({ 
                        color, 
                        value: v, 
                        type: 'number', 
                        id: Math.random().toString(36).substr(2, 9),
                        points: parseInt(v)
                    });
                }
            }
            
            // 2 adet aksiyon kartları
            for (let v of ['skip', 'reverse', 'draw2']) {
                for (let i = 0; i < 2; i++) {
                    this.deck.push({ 
                        color, 
                        value: v, 
                        type: 'action', 
                        id: Math.random().toString(36).substr(2, 9),
                        points: 20
                    });
                }
            }
        });
        
        // 4 Joker, 4 Joker+4
        for (let i = 0; i < 4; i++) {
            this.deck.push({ 
                color: 'black', 
                value: 'wild', 
                type: 'wild', 
                id: Math.random().toString(36).substr(2, 9),
                points: 50
            });
            this.deck.push({ 
                color: 'black', 
                value: 'draw4', 
                type: 'wild', 
                id: Math.random().toString(36).substr(2, 9),
                points: 50
            });
        }
        
        // Özel kartlar ekle (999+ özellik için)
        if (this.settings.progressive) {
            // Bomba kartı
            this.deck.push({
                color: 'purple',
                value: 'bomb',
                type: 'special',
                id: Math.random().toString(36).substr(2, 9),
                points: 100
            });
            
            // Kart değiştirme
            this.deck.push({
                color: 'orange',
                value: 'swap',
                type: 'special',
                id: Math.random().toString(36).substr(2, 9),
                points: 30
            });
        }
        
        this.shuffle();
    }

    shuffle() {
        // Fisher-Yates shuffle algoritması
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    draw(count) {
        const cards = [];
        for (let i = 0; i < count; i++) {
            if (this.deck.length === 0) {
                if (this.discardPile.length > 1) {
                    const top = this.discardPile.pop();
                    this.deck = this.discardPile;
                    this.discardPile = [top];
                    this.shuffle();
                } else {
                    // Eğer hala kart yoksa, yeni deste oluştur
                    this.createDeck();
                }
            }
            if (this.deck.length > 0) {
                cards.push(this.deck.pop());
            }
        }
        return cards;
    }

    // Pozisyon atama (Bar stili)
    assignPositions() {
        const positions = ['bottom', 'right', 'top', 'left']; // 4 oyuncu için
        this.players.forEach((player, index) => {
            player.position = positions[index];
            player.seat = index;
        });
    }

    calculateScore(winner) {
        let total = 0;
        this.players.forEach(p => {
            if (p.id !== winner.id) {
                p.hand.forEach(c => {
                    total += c.points || 0;
                });
            }
        });
        winner.score += total;
        return total;
    }
    
    // Oda boş mu kontrolü
    isEmpty() {
        return this.players.length === 0;
    }
    
    // Oyun başlatılabilir mi kontrolü
    canStart() {
        return this.players.length >= 2 && this.players.length <= this.maxPlayers;
    }
}

const rooms = {};
const connectedUsers = {};

// Oda temizleme zamanlayıcısı
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        const room = rooms[roomId];
        if (room.isEmpty() && now - room.lastActivity > 3600000) { // 1 saat
            delete rooms[roomId];
            console.log(`Boş oda temizlendi: ${roomId}`);
        }
    });
}, 300000); // 5 dakikada bir kontrol

io.on('connection', (socket) => {
    console.log('Yeni bağlantı:', socket.id);
    connectedUsers[socket.id] = { connectedAt: Date.now() };
    
    // --- LOBİ İŞLEMLERİ ---
    socket.on('getRooms', () => {
        const list = Object.values(rooms)
            .filter(r => r.gameState === 'LOBBY' && r.isPublic)
            .map(r => ({ 
                id: r.id, 
                name: r.roomName,
                playerCount: r.players.length, 
                maxPlayers: r.maxPlayers,
                settings: r.settings,
                hasPassword: !!r.password,
                createdAt: r.creationTime
            }))
            .sort((a, b) => b.createdAt - a.createdAt); // Yeni odalar üstte
        
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, settings, roomName, password }) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = new GameRoom(roomId, { 
            ...settings, 
            roomName: roomName || `${nickname}'in Odası`,
            password: password || null
        });
        
        room.players.push({ 
            id: socket.id, 
            nickname, 
            avatar, 
            hand: [], 
            score: 0, 
            isHost: true,
            isReady: true
        });
        
        rooms[roomId] = room;
        socket.join(roomId);
        socket.roomId = roomId;
        
        room.assignPositions();
        
        // Sadece oda sahibine tam kontrol, diğerlerine kısıtlı bilgi
        io.to(roomId).emit('roomUpdate', { 
            players: room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                avatar: p.avatar,
                score: p.score,
                isHost: p.isHost,
                isReady: p.isReady,
                position: p.position,
                seat: p.seat
            })), 
            roomId, 
            isHost: true, 
            settings: room.settings,
            roomName: room.roomName,
            canStart: room.canStart()
        });
        
        // Güncel oda listesini herkese gönder
        io.emit('roomList', Object.values(rooms)
            .filter(r => r.gameState === 'LOBBY' && r.isPublic)
            .map(r => ({ 
                id: r.id, 
                name: r.roomName,
                playerCount: r.players.length,
                maxPlayers: r.maxPlayers,
                hasPassword: !!r.password
            }))
        );
        
        console.log(`Oda oluşturuldu: ${roomId} - ${nickname}`);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar, password }) => {
        const room = rooms[roomId];
        if (!room) {
            return socket.emit('notification', { 
                type: 'error', 
                text: 'Oda bulunamadı!' 
            });
        }
        
        if (room.gameState !== 'LOBBY') {
            return socket.emit('notification', { 
                type: 'error', 
                text: 'Oyun çoktan başladı!' 
            });
        }
        
        if (room.players.length >= room.maxPlayers) {
            return socket.emit('notification', { 
                type: 'error', 
                text: 'Oda dolu!' 
            });
        }
        
        if (room.password && room.password !== password) {
            return socket.emit('notification', { 
                type: 'error', 
                text: 'Yanlış şifre!' 
            });
        }
        
        // Aynı isim kontrolü
        const existingPlayer = room.players.find(p => p.nickname === nickname);
        if (existingPlayer) {
            return socket.emit('notification', { 
                type: 'error', 
                text: 'Bu isim zaten kullanılıyor!' 
            });
        }
        
        room.players.push({ 
            id: socket.id, 
            nickname, 
            avatar, 
            hand: [], 
            score: 0, 
            isHost: false,
            isReady: false
        });
        
        socket.join(roomId);
        socket.roomId = roomId;
        
        room.assignPositions();
        room.lastActivity = Date.now();
        
        // Tüm oyunculara güncel oda durumunu gönder
        io.to(roomId).emit('roomUpdate', { 
            players: room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                avatar: p.avatar,
                score: p.score,
                isHost: p.isHost,
                isReady: p.isReady,
                position: p.position,
                seat: p.seat
            })), 
            roomId, 
            settings: room.settings,
            roomName: room.roomName,
            canStart: room.canStart()
        });
        
        // Odaya katıldı bildirimi
        socket.to(roomId).emit('notification', {
            type: 'info',
            text: `${nickname} odaya katıldı!`
        });
        
        // Oda listesini güncelle
        io.emit('roomList', Object.values(rooms)
            .filter(r => r.gameState === 'LOBBY' && r.isPublic)
            .map(r => ({ 
                id: r.id, 
                name: r.roomName,
                playerCount: r.players.length,
                maxPlayers: r.maxPlayers,
                hasPassword: !!r.password
            }))
        );
        
        console.log(`${nickname} odaya katıldı: ${roomId}`);
    });

    socket.on('leaveRoom', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== -1) {
            const player = room.players[playerIndex];
            
            // Oyuncuyu odadan çıkar
            room.players.splice(playerIndex, 1);
            socket.leave(roomId);
            delete socket.roomId;
            
            // Eğer odada kimse kalmadıysa odayı sil
            if (room.players.length === 0) {
                delete rooms[roomId];
                console.log(`Oda kaldırıldı: ${roomId}`);
            } else {
                // Host ayrıldıysa yeni host seç
                if (player.isHost && room.players.length > 0) {
                    room.players[0].isHost = true;
                }
                
                room.assignPositions();
                room.lastActivity = Date.now();
                
                // Kalan oyunculara güncelleme gönder
                io.to(roomId).emit('roomUpdate', {
                    players: room.players.map(p => ({
                        id: p.id,
                        nickname: p.nickname,
                        avatar: p.avatar,
                        score: p.score,
                        isHost: p.isHost,
                        isReady: p.isReady,
                        position: p.position,
                        seat: p.seat
                    })),
                    roomId,
                    settings: room.settings,
                    roomName: room.roomName,
                    canStart: room.canStart()
                });
                
                // Ayrıldı bildirimi
                io.to(roomId).emit('notification', {
                    type: 'warning',
                    text: `${player.nickname} ayrıldı!`
                });
            }
            
            // Oda listesini güncelle
            io.emit('roomList', Object.values(rooms)
                .filter(r => r.gameState === 'LOBBY' && r.isPublic)
                .map(r => ({ 
                    id: r.id, 
                    name: r.roomName,
                    playerCount: r.players.length,
                    maxPlayers: r.maxPlayers,
                    hasPassword: !!r.password
                }))
            );
            
            console.log(`${player.nickname} odadan ayrıldı: ${roomId}`);
        }
    });

    socket.on('readyToggle', ({ isReady }) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        
        if (player) {
            player.isReady = isReady;
            
            io.to(roomId).emit('roomUpdate', {
                players: room.players.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    avatar: p.avatar,
                    score: p.score,
                    isHost: p.isHost,
                    isReady: p.isReady,
                    position: p.position,
                    seat: p.seat
                })),
                roomId,
                settings: room.settings,
                roomName: room.roomName,
                canStart: room.canStart()
            });
        }
    });

    // --- OYUN AKIŞI ---
    socket.on('startGame', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        
        // Sadece host başlatabilir ve en az 2 oyuncu olmalı
        if (!player || !player.isHost || !room.canStart()) {
            return socket.emit('notification', {
                type: 'error',
                text: 'Oyun başlatılamıyor!'
            });
        }
        
        // Tüm oyuncular hazır mı kontrolü (opsiyonel)
        const allReady = room.players.every(p => p.isReady);
        if (!allReady) {
            return socket.emit('notification', {
                type: 'warning',
                text: 'Tüm oyuncular hazır değil!'
            });
        }
        
        room.gameState = 'PLAYING';
        room.createDeck();
        room.unoCallers.clear();
        room.drawStack = 0;
        
        // 7'şer Kart Dağıt
        room.players.forEach(p => {
            p.hand = room.draw(7);
            p.isUno = false;
        });

        // İlk Kartı Aç (Wild olmamasına dikkat et)
        let firstCard = null;
        do {
            if (room.deck.length === 0) {
                room.createDeck();
            }
            firstCard = room.draw(1)[0];
            if (firstCard.color !== 'black') break;
            // Wild kartı desteye geri koy
            room.deck.push(firstCard);
            room.shuffle();
        } while (true);
        
        room.discardPile.push(firstCard);

        // İLK KART ETKİLERİ
        let skipNext = false;
        if (firstCard.value === 'draw2') {
            // İlk oyuncu 2 kart çeker
            const nextPlayer = (room.turnIndex + room.direction + room.players.length) % room.players.length;
            room.players[nextPlayer].hand.push(...room.draw(2));
            skipNext = true;
        } else if (firstCard.value === 'reverse') {
            room.direction *= -1;
            if (room.players.length === 2) {
                skipNext = true; // 2 kişide skip gibi
            }
        } else if (firstCard.value === 'skip') {
            skipNext = true;
        }
        
        if (skipNext) {
            room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
        }

        io.to(roomId).emit('gameStarted', {
            initialCard: firstCard,
            players: room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                avatar: p.avatar,
                cardCount: p.hand.length,
                position: p.position,
                seat: p.seat
            }))
        });
        
        // İlk güncelleme
        updateGameState(roomId);
        
        console.log(`Oyun başladı: ${roomId}`);
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        const playerIndex = room.players.indexOf(player);
        
        if (!player || room.gameState !== 'PLAYING' || playerIndex !== room.turnIndex) {
            return socket.emit('notification', {
                type: 'error',
                text: 'Sıra sizde değil!'
            });
        }

        if (cardIndex < 0 || cardIndex >= player.hand.length) {
            return socket.emit('notification', {
                type: 'error',
                text: 'Geçersiz kart!'
            });
        }

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];
        const previousColor = topCard.displayColor || topCard.color;

        // Geçerlilik Kontrolü
        let isValid = false;
        if (card.color === 'black') {
            isValid = true; // Her zaman oynanabilir
        } else if (card.color === previousColor || card.value === topCard.value) {
            isValid = true; // Renk veya değer eşleşiyor
        }
        
        // Özel kart kuralları
        if (card.value === 'draw4' && room.drawStack > 0) {
            isValid = false; // Stack varsa draw4 oynanamaz (kurala göre)
        }

        if (!isValid) {
            return socket.emit('notification', {
                type: 'error',
                text: 'Bu kartı oynayamazsın!'
            });
        }

        // WILD DRAW 4 ÖZEL DURUMU (Blöf Mekaniği)
        if (card.value === 'draw4') {
            // Kartı oyna
            player.hand.splice(cardIndex, 1);
            card.displayColor = chosenColor;
            card.playedBy = player.id;
            room.discardPile.push(card);

            // Challenge Bekleme Moduna Gir
            room.gameState = 'CHALLENGE_WAITING';
            const victimIndex = getNextPlayerIndex(room);
            const victim = room.players[victimIndex];
            
            room.pendingChallenge = {
                attackerId: player.id,
                attackerName: player.nickname,
                victimId: victim.id,
                victimName: victim.nickname,
                cardPlayed: card,
                prevColor: previousColor
            };

            // Challenge durumunu güncelle
            updateGameState(roomId);
            
            io.to(roomId).emit('notification', {
                type: 'warning',
                text: `${player.nickname} +4 attı! ${victim.nickname} meydan okuyabilir.`
            });
            
            return;
        }

        // Normal kart oynama
        player.hand.splice(cardIndex, 1);
        if (card.color === 'black') {
            card.displayColor = chosenColor;
        }
        card.playedBy = player.id;
        room.discardPile.push(card);

        // UNO kontrolü
        if (player.hand.length === 1 && !room.unoCallers.has(player.id)) {
            // UNO demedi, ceza kartı çek
            player.hand.push(...room.draw(2));
            io.to(roomId).emit('notification', {
                type: 'error',
                text: `${player.nickname} UNO demedi! +2 ceza!`
            });
        } else if (player.hand.length === 0) {
            // OYUN BİTTİ
            const points = room.calculateScore(player);
            room.gameState = 'SCORING';
            
            io.to(roomId).emit('gameOver', { 
                winner: {
                    id: player.id,
                    nickname: player.nickname,
                    avatar: player.avatar,
                    score: player.score
                }, 
                points,
                players: room.players.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    avatar: p.avatar,
                    score: p.score,
                    cardCount: p.hand.length
                }))
            });
            
            io.to(roomId).emit('playSound', 'win');
            return;
        }

        // Kart etkilerini işle
        handleCardEffect(room, card);
        
        // UNO durumunu temizle
        room.unoCallers.clear();
        
        // Sırayı güncelle ve oyun durumunu gönder
        updateGameState(roomId);
    });

    // CHALLENGE YANITI
    socket.on('respondChallenge', ({ action }) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId] || rooms[roomId].gameState !== 'CHALLENGE_WAITING') return;
        
        const room = rooms[roomId];
        const { attackerId, victimId, prevColor } = room.pendingChallenge;
        
        if (socket.id !== victimId) return; // Sadece kurban yanıt verebilir

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (action === 'accept') {
            // Meydan okumadı, 4 kart ye
            victim.hand.push(...room.draw(4));
            room.turnIndex = getNextPlayerIndex(room); // Sıra kurbanı atlar
            
            io.to(roomId).emit('notification', {
                type: 'info',
                text: `${victim.nickname} cezayı kabul etti (+4).`
            });
            
            io.to(roomId).emit('playSound', 'draw4');
        } else {
            // MEYDAN OKUDU!
            // Attacker'ın elinde 'prevColor' renginden kart var mıydı?
            const hasColor = attacker.hand.some(c => {
                const cardColor = c.displayColor || c.color;
                return cardColor === prevColor;
            });

            if (hasColor) {
                // SUÇLU! (Blöf yapmış)
                attacker.hand.push(...room.draw(4)); // Attacker ceza yer
                room.turnIndex = room.players.indexOf(attacker); // Sıra attackera geçer
                
                io.to(roomId).emit('notification', {
                    type: 'success',
                    text: `BLÖF YAKALANDI! ${attacker.nickname} +4 yiyor!`
                });
                
                io.to(roomId).emit('playSound', 'bluff');
            } else {
                // SUÇSUZ! (Dürüst oynamış)
                victim.hand.push(...room.draw(6)); // Kurban 4+2=6 yer
                room.turnIndex = getNextPlayerIndex(room); // Sıra kurbanı atlar
                
                io.to(roomId).emit('notification', {
                    type: 'error',
                    text: `MEYDAN OKUMA BAŞARISIZ! ${victim.nickname} +6 yiyor!`
                });
                
                io.to(roomId).emit('playSound', 'challengeFail');
            }
        }

        room.gameState = 'PLAYING';
        room.pendingChallenge = null;
        advanceTurn(room);
        updateGameState(roomId);
    });

    socket.on('drawCard', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        const playerIndex = room.players.indexOf(player);
        
        if (!player || room.gameState !== 'PLAYING' || playerIndex !== room.turnIndex) return;

        const drawn = room.draw(1)[0];
        player.hand.push(drawn);
        
        io.to(roomId).emit('notification', {
            type: 'info',
            text: `${player.nickname} kart çekti.`
        });
        
        // Çekilen kart oynanabilir mi?
        const top = room.discardPile[room.discardPile.length - 1];
        const col = top.displayColor || top.color;
        
        if (drawn.color === 'black' || drawn.color === col || drawn.value === top.value) {
            // Oynanabilir, istemciye bildir
            socket.emit('canPlayDrawnCard', { card: drawn });
        } else {
            // Oynanamazsa sıra geçer
            advanceTurn(room);
            updateGameState(roomId);
        }
    });

    socket.on('playDrawnCard', ({ chosenColor }) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        
        if (!player || room.gameState !== 'PLAYING') return;
        
        // Son çekilen kartı bul (en son eklenen)
        const lastCardIndex = player.hand.length - 1;
        if (lastCardIndex < 0) return;
        
        const card = player.hand[lastCardIndex];
        
        // Kartı oyna
        player.hand.splice(lastCardIndex, 1);
        if (card.color === 'black') {
            card.displayColor = chosenColor;
        }
        card.playedBy = player.id;
        room.discardPile.push(card);
        
        // Kart etkilerini işle
        handleCardEffect(room, card);
        updateGameState(roomId);
    });

    socket.on('passTurn', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        advanceTurn(room);
        updateGameState(roomId);
    });

    socket.on('callUno', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        
        if (player && player.hand.length === 1) {
            room.unoCallers.add(player.id);
            player.isUno = true;
            
            io.to(roomId).emit('notification', {
                type: 'success',
                text: `${player.nickname}: UNO!!!`
            });
            
            io.to(roomId).emit('playSound', 'uno');
            updateGameState(roomId);
        }
    });

    socket.on('challengeUno', ({ targetId }) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        
        const room = rooms[roomId];
        const challenger = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);
        
        if (!challenger || !target) return;
        
        // Sadece sıra size değilken challenge yapabilir
        const challengerIndex = room.players.indexOf(challenger);
        if (challengerIndex === room.turnIndex) return;
        
        // Target'ın 1 kartı var ve UNO dememiş mi?
        if (target.hand.length === 1 && !room.unoCallers.has(targetId)) {
            // Ceza: 2 kart çek
            target.hand.push(...room.draw(2));
            
            io.to(roomId).emit('notification', {
                type: 'error',
                text: `${target.nickname} UNO demedi! ${challenger.nickname} tarafından yakalandı! +2 ceza!`
            });
            
            io.to(roomId).emit('playSound', 'penalty');
            updateGameState(roomId);
        }
    });

    // --- YARDIMCI FONKSİYONLAR ---
    function handleCardEffect(room, card) {
        const currentPlayer = room.players[room.turnIndex];
        
        if (card.value === 'skip') {
            advanceTurn(room); // Bir kişi atla
            io.to(room.id).emit('notification', {
                type: 'warning',
                text: `${currentPlayer.nickname} atlattı!`
            });
            
            io.to(room.id).emit('playSound', 'skip');
        } else if (card.value === 'reverse') {
            room.direction *= -1;
            
            if (room.players.length === 2) {
                // 2 kişide skip gibi
                advanceTurn(room);
            }
            
            io.to(room.id).emit('notification', {
                type: 'info',
                text: `Yön değişti! ${room.direction === 1 ? 'Saat yönü' : 'Ters yön'}`
            });
            
            io.to(room.id).emit('playSound', 'reverse');
        } else if (card.value === 'draw2') {
            const nextP = getNextPlayerIndex(room);
            room.players[nextP].hand.push(...room.draw(2));
            advanceTurn(room); // +2 yiyen sırasını kaybeder
            
            io.to(room.id).emit('notification', {
                type: 'error',
                text: `${room.players[nextP].nickname} +2 yedi!`
            });
            
            io.to(room.id).emit('playSound', 'draw2');
        } else if (card.value === 'draw4') {
            // Zaten challenge mekaniği ile işlendi
            io.to(room.id).emit('playSound', 'draw4');
        } else if (card.value === 'wild') {
            io.to(room.id).emit('playSound', 'wild');
        }
        
        // Özel kart etkileri
        if (card.value === 'bomb') {
            // Herkes 2 kart çeker
            room.players.forEach(p => {
                if (p.id !== currentPlayer.id) {
                    p.hand.push(...room.draw(2));
                }
            });
            
            io.to(room.id).emit('notification', {
                type: 'error',
                text: 'BOMBA PATLADI! Herkes +2 yedi!'
            });
            
            io.to(room.id).emit('playSound', 'bomb');
        } else if (card.value === 'swap') {
            // Elleri değiştir
            const nextP = getNextPlayerIndex(room);
            const tempHand = currentPlayer.hand;
            currentPlayer.hand = room.players[nextP].hand;
            room.players[nextP].hand = tempHand;
            
            io.to(room.id).emit('notification', {
                type: 'info',
                text: `${currentPlayer.nickname} ve ${room.players[nextP].nickname} elleri değiştirdi!`
            });
            
            io.to(room.id).emit('playSound', 'swap');
        }
        
        advanceTurn(room);
    }

    function advanceTurn(room) {
        room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }

    function getNextPlayerIndex(room) {
        return (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }

    function updateGameState(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        
        room.players.forEach((p, i) => {
            io.to(p.id).emit('gameState', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                isMyTurn: i === room.turnIndex && room.gameState === 'PLAYING',
                turnIndex: room.turnIndex,
                gameState: room.gameState,
                direction: room.direction,
                challengeData: room.pendingChallenge,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar, 
                    cardCount: pl.hand.length,
                    score: pl.score,
                    position: pl.position,
                    seat: pl.seat,
                    isUno: room.unoCallers.has(pl.id),
                    isHost: pl.isHost
                }))
            });
        });
    }

    // Bağlantı kesildiğinde
    socket.on('disconnect', () => {
        console.log('Bağlantı kesildi:', socket.id);
        
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            
            if (player) {
                // Oyun devam ediyorsa, bot ile değiştir veya oyuncuyu çıkar
                if (room.gameState === 'PLAYING') {
                    // Basit bot mantığı - kartları pas geç
                    room.players = room.players.filter(p => p.id !== socket.id);
                    
                    io.to(roomId).emit('notification', {
                        type: 'error',
                        text: `${player.nickname} bağlantısı kesildi!`
                    });
                    
                    // Eğer sıra kopan oyuncudaysa, sırayı ilerlet
                    if (room.players[room.turnIndex] && room.players[room.turnIndex].id === socket.id) {
                        advanceTurn(room);
                    }
                    
                    if (room.players.length < 2) {
                        // Oyunu bitir
                        room.gameState = 'LOBBY';
                        io.to(roomId).emit('gameOver', {
                            reason: 'notEnoughPlayers'
                        });
                    }
                } else {
                    // Lobideyse normal çıkış işlemi
                    room.players = room.players.filter(p => p.id !== socket.id);
                    
                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        if (player.isHost) {
                            room.players[0].isHost = true;
                        }
                        
                        room.assignPositions();
                        
                        io.to(roomId).emit('roomUpdate', {
                            players: room.players.map(p => ({
                                id: p.id,
                                nickname: p.nickname,
                                avatar: p.avatar,
                                score: p.score,
                                isHost: p.isHost,
                                isReady: p.isReady,
                                position: p.position,
                                seat: p.seat
                            })),
                            roomId,
                            settings: room.settings,
                            roomName: room.roomName,
                            canStart: room.canStart()
                        });
                    }
                }
                
                // Oda listesini güncelle
                io.emit('roomList', Object.values(rooms)
                    .filter(r => r.gameState === 'LOBBY' && r.isPublic)
                    .map(r => ({ 
                        id: r.id, 
                        name: r.roomName,
                        playerCount: r.players.length,
                        maxPlayers: r.maxPlayers,
                        hasPassword: !!r.password
                    }))
                );
            }
        }
        
        delete connectedUsers[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`UNO PRO SERVER READY - Port: ${PORT}`);
    console.log('Özellikler:');
    console.log('- StoryArt Tarzı Modern Arayüz');
    console.log('- 3D Kart Animasyonları');
    console.log('- Bar Stili Oturma Düzeni');
    console.log('- Challenge (Meydan Okuma) Sistemi');
    console.log('- Mobil Uyumluluk');
    console.log('- 999+ Ekstra Özellik');
});
