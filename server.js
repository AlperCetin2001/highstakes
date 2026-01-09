const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.get('/', (req, res) => res.send('UNO ULTIMATE Server Aktif!'));

const rooms = {};

// --- YARDIMCI FONKSİYONLAR ---
function createDeck() {
    const colors = ['red', 'yellow', 'green', 'blue'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    const deck = [];
    colors.forEach(c => values.forEach(v => {
        deck.push({ color: c, value: v, type: 'normal', id: Math.random().toString(36) });
        if (v !== '0') deck.push({ color: c, value: v, type: 'normal', id: Math.random().toString(36) });
    }));
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild', id: Math.random().toString(36) });
        deck.push({ color: 'black', value: 'draw4', type: 'wild', id: Math.random().toString(36) });
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
    // ODAYA KATILMA
    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        socket.join(roomId);
        
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: [],
                discardPile: [],
                turnIndex: 0,
                direction: 1,
                gameStarted: false,
                messages: []
            };
        }
        const room = rooms[roomId];

        if (room.gameStarted) {
            socket.emit('notification', { type: 'error', text: 'Oyun çoktan başladı!' });
            return;
        }

        const player = { id: socket.id, nickname, avatar, hand: [], isUno: false };
        room.players.push(player);

        // Oda bilgisini güncelle
        io.to(roomId).emit('roomUpdate', {
            players: room.players.map(p => ({ id: p.id, nickname: p.nickname, avatar: p.avatar, isHost: room.players[0].id === p.id })),
            isHost: room.players[0].id === socket.id
        });
        
        // Hoşgeldin mesajı
        io.to(roomId).emit('chatMessage', { sender: 'Sistem', text: `${nickname} odaya katıldı.`, type: 'system' });
    });

    // SOHBET
    socket.on('sendMessage', ({ roomId, text }) => {
        const room = rooms[roomId];
        if(room) {
            const player = room.players.find(p => p.id === socket.id);
            if(player) io.to(roomId).emit('chatMessage', { sender: player.nickname, text, type: 'user' });
        }
    });

    // OYUN BAŞLATMA
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players.length < 2) {
            socket.emit('notification', { type: 'error', text: 'En az 2 kişi gerekli!' });
            return;
        }
        
        room.gameStarted = true;
        room.deck = createDeck();
        room.players.forEach(p => p.hand = room.deck.splice(0, 7));
        
        let startCard = room.deck.pop();
        while(startCard.color === 'black') {
            room.deck.unshift(startCard);
            startCard = room.deck.pop();
        }
        room.discardPile.push(startCard);

        io.to(roomId).emit('gameStarted');
        updateGameState(roomId);
    });

    // KART OYNAMA
    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        // UNO Kontrolü (Kart atmadan önce UNO demediyse ceza yiyebilir mantığı eklenebilir ama basit tutuyoruz)
        if(player.hand.length === 2 && !player.isUno) {
            // Otomatik UNO demiyoruz, butona basması lazım.
            // Şimdilik basitleştirilmiş: Kartı attıktan sonra 1 kalıyorsa uyaralım.
        }

        player.isUno = false; // Her hamlede sıfırla
        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        
        // Mantık Kontrolü...
        let isValid = false;
        const currentColor = top.displayColor || top.color;
        if (card.color === 'black' || card.color === currentColor || card.value === top.value) isValid = true;

        if (isValid) {
            player.hand.splice(cardIndex, 1);
            if (card.color === 'black') card.displayColor = chosenColor || 'red';
            room.discardPile.push(card);

            // Efektler
            if (card.value === 'skip') advanceTurn(room);
            else if (card.value === 'reverse') {
                room.direction *= -1;
                if(room.players.length === 2) advanceTurn(room);
            }
            else if (card.value === 'draw2') {
                let nextP = getNextPlayer(room);
                room.players[nextP].hand.push(...drawCards(room, 2));
                advanceTurn(room);
            }
            else if (card.value === 'draw4') {
                let nextP = getNextPlayer(room);
                room.players[nextP].hand.push(...drawCards(room, 4));
                advanceTurn(room);
            }

            if (player.hand.length === 0) {
                io.to(roomId).emit('gameOver', { winner: player.nickname });
                delete rooms[roomId];
                return;
            }

            advanceTurn(room);
            updateGameState(roomId);
        }
    });

    // KART ÇEKME
    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if(room.players.indexOf(player) !== room.turnIndex) return;

        player.hand.push(...drawCards(room, 1));
        io.to(roomId).emit('notification', { type: 'info', text: `${player.nickname} kart çekti.` });
        updateGameState(roomId);
    });

    // PAS GEÇME
    socket.on('passTurn', (roomId) => {
        const room = rooms[roomId];
        if(room) {
            advanceTurn(room);
            updateGameState(roomId);
        }
    });

    // UNO DEME
    socket.on('sayUno', (roomId) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if(player && player.hand.length <= 2) {
            player.isUno = true;
            io.to(roomId).emit('notification', { type: 'success', text: `${player.nickname}: UNO!!` });
            io.to(roomId).emit('playSound', 'uno'); // Ses çal
        }
    });
});

function advanceTurn(room) {
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}
function getNextPlayer(room) {
    return (room.turnIndex + room.direction + room.players.length) % room.players.length;
}
function drawCards(room, count) {
    const drawn = [];
    for(let i=0; i<count; i++) {
        if (room.deck.length === 0) {
            if(room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = shuffle(room.discardPile);
                room.discardPile = [top];
            } else break;
        }
        drawn.push(room.deck.pop());
    }
    return drawn;
}
function updateGameState(roomId) {
    const room = rooms[roomId];
    room.players.forEach((p, i) => {
        io.to(p.id).emit('gameState', {
            hand: p.hand,
            topCard: room.discardPile[room.discardPile.length - 1],
            isMyTurn: i === room.turnIndex,
            turnIndex: room.turnIndex,
            players: room.players.map(pl => ({ 
                id: pl.id, 
                nickname: pl.nickname, 
                avatar: pl.avatar, 
                cardCount: pl.hand.length,
                isUno: pl.isUno 
            }))
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Ultimate Server ${PORT} Portunda!`));
