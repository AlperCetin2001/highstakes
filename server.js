const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.get('/', (req, res) => {
    res.send('UNO Server Aktif (Guncel Versiyon)!');
});

const rooms = {};

// --- OYUN FONKSİYONLARI ---
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
    console.log('✅ Bağlantı:', socket.id);

    // ODAYA KATILMA
    socket.on('joinRoom', (roomId) => {
        console.log(`➡️ ${socket.id} kullanıcısı ${roomId} odasına girmek istiyor.`);

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

        if (room.gameStarted) {
            socket.emit('error', 'Bu oda şu an oyunda, giremezsin!');
            return;
        }

        // Aynı kişi tekrar girmesin
        const isAlreadyIn = room.players.find(p => p.id === socket.id);
        if (!isAlreadyIn) {
            room.players.push({ id: socket.id, hand: [] });
            socket.join(roomId);
        }

        // Odadaki herkese güncel sayıyı bildir
        io.to(roomId).emit('playerJoined', room.players.length);
        
        // Odayı kuran (ilk kişi) yönetici olsun
        if (room.players[0].id === socket.id) {
            socket.emit('isHost', true);
        }
    });

    // OYUNU BAŞLATMA
    socket.on('startGame', (roomId) => {
        console.log(`▶️ Start isteği: Oda ${roomId}, İsteyen ${socket.id}`);
        
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Oda bulunamadı!');
            return;
        }

        // KRİTİK KONTROL: Tek başına başlatmaya çalışıyorsan hata ver
        if (room.players.length < 2) {
            console.log("❌ Yetersiz oyuncu sayısı.");
            socket.emit('error', 'Oyunu başlatmak için EN AZ 2 OYUNCU gerekiyor! Yan sekmeden başka bir isimle girmeyi dene.');
            return;
        }

        room.gameStarted = true;
        room.deck = createDeck();
        
        // Kartları Dağıt
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

        console.log("✅ Oyun başlatıldı, durum gönderiliyor...");
        updateGameState(roomId);
    });

    // KART OYNAMA
    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Sıra kontrolü
        const playerIndex = room.players.indexOf(player);
        if (playerIndex !== room.turnIndex) {
            socket.emit('error', 'Sıra sende değil!');
            return;
        }

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];

        // Geçerlilik Kontrolü
        let isValid = false;
        const currentMsgColor = topCard.displayColor || topCard.color;

        if (card.color === 'black') isValid = true;
        else if (card.color === currentMsgColor) isValid = true;
        else if (card.value === topCard.value) isValid = true;

        if (isValid) {
            // Kartı elden çıkar
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
                if(room.players.length === 2) advanceTurn(room);
            } else if (card.value === 'draw2') {
                let nextP = getNextPlayerIndex(room);
                room.players[nextP].hand.push(...drawCards(room, 2));
                advanceTurn(room);
            } else if (card.value === 'draw4') {
                let nextP = getNextPlayerIndex(room);
                room.players[nextP].hand.push(...drawCards(room, 4));
                advanceTurn(room);
            }

            // Oyun Bitti mi?
            if (player.hand.length === 0) {
                io.to(roomId).emit('gameOver', socket.id);
                delete rooms[roomId];
                return;
            }

            advanceTurn(room);
            updateGameState(roomId);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

    // KART ÇEKME
    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.turnIndex) return;

        player.hand.push(...drawCards(room, 1));
        updateGameState(roomId);
    });
    
    // PAS GEÇME
    socket.on('passTurn', (roomId) => {
         const room = rooms[roomId];
         if(!room) return;
         const player = room.players.find(p => p.id === socket.id);
         if (room.players.indexOf(player) !== room.turnIndex) return;
         
         advanceTurn(room);
         updateGameState(roomId);
    });

    socket.on('disconnect', () => {
        console.log('Kullanıcı çıktı:', socket.id);
    });
});

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
                break;
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server ${PORT} portunda hazır.`);
});
