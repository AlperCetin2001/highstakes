const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// 1. Express Uygulaması
const app = express();
app.use(cors()); // Tüm kaynaklara izin ver

// 2. HTTP Sunucusunu Express ile sarmala (Socket.io için gerekli)
const server = http.createServer(app);

// 3. Socket.io'yu başlat
const io = new Server(server, {
    cors: {
        origin: "*", // InfinityFree ve tüm yerlerden gelen isteklere izin ver
        methods: ["GET", "POST"]
    }
});

// Render'da sunucunun çalıştığını anlamak için basit bir rota
app.get('/', (req, res) => {
    res.send('UNO Server Aktif! Socket.io bekliyor...');
});

// --- OYUN MANTIĞI BAŞLANGICI ---
const rooms = {};

// Deste Oluşturma
function createDeck() {
    const colors = ['red', 'yellow', 'green', 'blue'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    const deck = [];

    colors.forEach(color => {
        values.forEach(value => {
            deck.push({ color, value, type: 'normal' });
            if (value !== '0') deck.push({ color, value, type: 'normal' });
        });
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild' });
        deck.push({ color: 'black', value: 'draw4', type: 'wild' });
    }

    return shuffle(deck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

io.on('connection', (socket) => {
    console.log('✅ Bir kullanıcı bağlandı:', socket.id);

    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: [],
                discardPile: [],
                turnIndex: 0,
                direction: 1,
                gameStarted: false
            };
        }

        const room = rooms[roomId];

        // Oyuncu zaten odada mı? (Yenileme durumu için)
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if(!existingPlayer) {
            if (room.gameStarted) {
                socket.emit('error', 'Oyun başladı, giremezsin!');
                return;
            }
            room.players.push({ id: socket.id, hand: [] });
            socket.join(roomId);
        }

        io.to(roomId).emit('playerJoined', room.players.length);
        
        // İlk giren yönetici olsun
        if (room.players[0].id === socket.id) {
            socket.emit('isHost', true);
        }
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players.length < 2) return;

        room.gameStarted = true;
        room.deck = createDeck();
        
        // Kart Dağıt
        room.players.forEach(player => {
            player.hand = room.deck.splice(0, 7);
        });

        // Ortaya Kart Aç
        let startCard = room.deck.pop();
        while(startCard.color === 'black') { 
            room.deck.unshift(startCard);
            startCard = room.deck.pop();
        }
        room.discardPile.push(startCard);

        updateGameState(roomId);
    });

    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        const playerIndex = room.players.indexOf(player);

        if (playerIndex !== room.turnIndex) return;

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];

        // Kural Kontrolü
        let isValid = false;
        
        // 1. Wild kart ise her zaman geçerli
        if (card.color === 'black') isValid = true;
        
        // 2. Renk tutuyorsa (Eğer önceki kart Wild ise displayColor'a bakılır)
        else if (card.color === (topCard.displayColor || topCard.color)) isValid = true;
        
        // 3. Sayı/Değer tutuyorsa
        else if (card.value === topCard.value) isValid = true;

        if (isValid) {
            // Kartı oyna
            player.hand.splice(cardIndex, 1);
            
            if (card.color === 'black') {
                card.displayColor = chosenColor || 'red'; 
            }

            room.discardPile.push(card);

            // Efektler
            if (card.value === 'skip') {
                advanceTurn(room);
            } else if (card.value === 'reverse') {
                room.direction *= -1;
                if(room.players.length === 2) advanceTurn(room); // 2 kişide reverse skip gibidir
            } else if (card.value === 'draw2') {
                let nextP = getNextPlayerIndex(room);
                room.players[nextP].hand.push(...drawCards(room, 2));
                advanceTurn(room); // +2 yiyen oynayamaz
            } else if (card.value === 'draw4') {
                let nextP = getNextPlayerIndex(room);
                room.players[nextP].hand.push(...drawCards(room, 4));
                advanceTurn(room); // +4 yiyen oynayamaz
            }

            // Kazanma Kontrolü
            if (player.hand.length === 0) {
                io.to(roomId).emit('gameOver', socket.id);
                delete rooms[roomId]; // Odayı temizle
                return;
            }

            advanceTurn(room);
            updateGameState(roomId);
        }
    });

    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.turnIndex) return;

        player.hand.push(...drawCards(room, 1));
        
        // Kart çektikten sonra sıra geçer mi? (Basitlik için evet)
        // advanceTurn(room); 
        
        updateGameState(roomId);
    });
    
    socket.on('passTurn', (roomId) => {
         const room = rooms[roomId];
         if(!room) return;
         advanceTurn(room);
         updateGameState(roomId);
    });

    socket.on('disconnect', () => {
        // Gelişmiş versiyonda oyuncu düşünce oda yönetimi yapılmalı
        console.log('Kullanıcı ayrıldı:', socket.id);
    });
});

// Yardımcı Fonksiyonlar
function advanceTurn(room) {
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function getNextPlayerIndex(room) {
    return (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function drawCards(room, count) {
    const drawn = [];
    for(let i=0; i<count; i++){
        if (room.deck.length === 0) {
            if(room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = shuffle(room.discardPile);
                room.discardPile = [top];
            } else {
                break; // Kart kalmadı
            }
        }
        drawn.push(room.deck.pop());
    }
    return drawn;
}

function updateGameState(roomId) {
    const room = rooms[roomId];
    room.players.forEach((player, index) => {
        const gameState = {
            hand: player.hand,
            topCard: room.discardPile[room.discardPile.length - 1],
            isMyTurn: index === room.turnIndex,
            opponentCardCounts: room.players.map(p => p.hand.length),
            turnIndex: room.turnIndex
        };
        io.to(player.id).emit('gameState', gameState);
    });
}

// 4. PORT Dinleme (BURASI ÇOK ÖNEMLİ)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { // app.listen DEĞİL!
    console.log(`🚀 Server running on port ${PORT}`);
});
