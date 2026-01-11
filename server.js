const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// CORS: Tüm kaynaklara izin ver (Hata almamak için)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rooms = new Map();

// --- YARDIMCI FONKSİYONLAR ---
function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    const deck = [];

    colors.forEach(color => {
        values.forEach(value => {
            deck.push({ color, value, type: 'normal', id: Math.random().toString(36) });
            if (value !== '0') deck.push({ color, value, type: 'normal', id: Math.random().toString(36) });
        });
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild', id: Math.random().toString(36) });
        deck.push({ color: 'black', value: 'wild4', type: 'wild', id: Math.random().toString(36) });
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

// --- SOCKET MANTIĞI ---
io.on('connection', (socket) => {
    console.log('Bağlantı:', socket.id);

    // Oda Listesi
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values())
            .filter(r => r.gameState === 'LOBBY')
            .map(r => ({ id: r.id, name: r.name, count: r.players.length }));
        socket.emit('roomList', list);
    });

    // Oda Kur
    socket.on('createRoom', ({ nickname }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id, // HOST GARANTİSİ
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: []
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname);
    });

    // Katıl
    socket.on('joinRoom', ({ roomId, nickname }) => {
        joinRoomHandler(socket, roomId, nickname);
    });

    // Başlat
    socket.on('startGame', () => {
        const roomId = getRoomIdBySocket(socket.id);
        const room = rooms.get(roomId);
        
        if (room && room.hostId === socket.id && room.players.length >= 2) {
            room.gameState = 'PLAYING';
            room.deck = createDeck();
            
            // Kart Dağıt
            room.players.forEach(p => {
                p.hand = room.deck.splice(0, 7);
            });

            // İlk Kart
            let first;
            do { first = room.deck.pop(); } while (first.color === 'black');
            
            room.discardPile.push(first);
            room.currentColor = first.color;
            
            addLog(room, "Oyun Başladı! Bol şans.");
            
            io.to(roomId).emit('gameStarted'); // Sadece sinyal gönder
            broadcastGameState(roomId);
        }
    });

    // Kart Oyna
    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;

        const card = player.hand[cardIndex];
        // Basit Doğrulama
        const top = room.discardPile[room.discardPile.length - 1];
        let valid = (card.color === 'black') || (card.color === room.currentColor) || (card.value === top.value);
        
        if (valid) {
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            addLog(room, `${player.nickname} bir ${formatCardName(card)} oynadı.`);

            // Efektler
            let skip = false;
            if (card.value === 'skip') { skip = true; addLog(room, "Sıra atladı!"); }
            if (card.value === 'reverse') { 
                room.direction *= -1; 
                addLog(room, "Yön değişti!");
                if (room.players.length === 2) skip = true; 
            }
            if (card.value === 'draw2') {
                const next = getNextPlayer(room);
                drawCards(room, next, 2);
                addLog(room, `${next.nickname} +2 yedi!`);
                skip = true;
            }
            if (card.value === 'wild4') {
                const next = getNextPlayer(room);
                drawCards(room, next, 4);
                addLog(room, `${next.nickname} +4 yedi!`);
                skip = true;
            }

            // Kazanma
            if (player.hand.length === 0) {
                io.to(roomId).emit('gameOver', { winner: player.nickname });
                rooms.delete(roomId);
                return;
            }

            advanceTurn(room);
            if (skip) advanceTurn(room);
            
            broadcastGameState(roomId);
        }
    });

    // Kart Çek
    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (room.players[room.turnIndex].id !== socket.id) return;

        const player = room.players[room.turnIndex];
        drawCards(room, player, 1);
        addLog(room, `${player.nickname} kart çekti.`);
        
        advanceTurn(room);
        broadcastGameState(roomId);
    });

    // Chat Mesajı
    socket.on('sendMessage', (msg) => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            const player = room.players.find(p => p.id === socket.id);
            io.to(roomId).emit('chatMessage', { user: player.nickname, text: msg });
        }
    });

    socket.on('disconnect', () => {
        // Basit kopma yönetimi
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) rooms.delete(roomId);
            else {
                if(socket.id === room.hostId) {
                    room.hostId = room.players[0].id; // Yeni host
                }
                broadcastGameState(roomId);
            }
        }
    });
});

// --- YARDIMCILAR ---
function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}

function getRoomIdBySocket(socketId) {
    return getPlayerRoomId(socketId);
}

function joinRoomHandler(socket, roomId, nickname) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    
    socket.join(roomId);
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        room.players.push({ id: socket.id, nickname, hand: [] });
    }
    
    // Anında güncelleme gönder
    broadcastGameState(roomId);
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId), // HOST BURADA BELİRLENİR
                gameState: room.gameState,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    cardCount: pl.hand.length,
                    isTurn: room.players[room.turnIndex].id === pl.id
                })),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname
            });
        }
    });
}

function drawCards(room, player, count) {
    for(let i=0; i<count; i++) {
        if(room.deck.length === 0) {
            if(room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = shuffle(room.discardPile);
                room.discardPile = [top];
            } else break;
        }
        player.hand.push(room.deck.pop());
    }
}

function advanceTurn(room) {
    room.turnIndex += room.direction;
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.turnIndex < 0) room.turnIndex = room.players.length - 1;
}

function getNextPlayer(room) {
    let idx = room.turnIndex + room.direction;
    if (idx >= room.players.length) idx = 0;
    if (idx < 0) idx = room.players.length - 1;
    return room.players[idx];
}

function addLog(room, msg) {
    room.logs.push(msg);
    if(room.logs.length > 5) room.logs.shift();
}

function formatCardName(c) {
    if(c.color === 'black') return c.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${c.color} ${c.value}`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Sunucu Hazır!'));
