const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- OYUN VERİLERİ ---
const rooms = new Map();

// --- YARDIMCI FONKSİYONLAR ---
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
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

// --- SOCKET.IO OLAYLARI ---
io.on('connection', (socket) => {
    console.log('Bağlandı:', socket.id);

    // Oda Listesini Gönder
    socket.on('getRooms', () => {
        const roomList = Array.from(rooms.values())
            .filter(r => r.gameState === 'LOBBY')
            .map(r => ({ id: r.id, name: r.name, count: r.players.length }));
        socket.emit('roomList', roomList);
    });

    // Oda Oluştur
    socket.on('createRoom', ({ nickname, roomName }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: roomName || `${nickname}'in Odası`,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null
        };
        rooms.set(roomId, room);
        joinRoomLogic(socket, roomId, nickname);
    });

    // Odaya Katıl
    socket.on('joinRoom', ({ roomId, nickname }) => {
        joinRoomLogic(socket, roomId, nickname);
    });

    // Oyunu Başlat
    socket.on('startGame', () => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        const room = rooms.get(roomId);
        if (room && room.players[0].id === socket.id && room.players.length >= 2) {
            room.gameState = 'PLAYING';
            room.deck = createDeck();
            
            // Oyunculara kart dağıt
            room.players.forEach(p => {
                p.hand = room.deck.splice(0, 7);
            });

            // İlk kartı aç (Wild olmamalı)
            let firstCard;
            do {
                firstCard = room.deck.pop();
            } while (firstCard.color === 'black');
            
            room.discardPile.push(firstCard);
            room.currentColor = firstCard.color;

            io.to(roomId).emit('gameStarted', { 
                discardPile: room.discardPile[room.discardPile.length - 1],
                currentColor: room.currentColor
            });
            updateGameState(roomId);
        }
    });

    // Kart Oynama
    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        const room = rooms.get(roomId);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (room.players[room.turnIndex].id !== socket.id) return; // Sıra kontrolü

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];

        // Geçerlilik Kontrolü
        let isValid = false;
        if (card.color === 'black') isValid = true;
        else if (card.color === room.currentColor) isValid = true;
        else if (card.value === topCard.value) isValid = true;

        if (isValid) {
            // Kartı elden çıkar
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            // Renk Güncelleme
            if (card.color === 'black') {
                room.currentColor = chosenColor;
            } else {
                room.currentColor = card.color;
            }

            // Özel Kart Etkileri
            let skipNext = false;
            if (card.value === 'skip') skipNext = true;
            else if (card.value === 'reverse') {
                room.direction *= -1;
                if (room.players.length === 2) skipNext = true;
            }
            else if (card.value === 'draw2') {
                const nextP = getNextPlayer(room);
                drawCards(room, nextP, 2);
                skipNext = true;
            }
            else if (card.value === 'wild4') {
                const nextP = getNextPlayer(room);
                drawCards(room, nextP, 4);
                skipNext = true;
            }

            // Kazanma Kontrolü
            if (player.hand.length === 0) {
                io.to(roomId).emit('gameOver', { winner: player.nickname });
                rooms.delete(roomId);
                return;
            }

            // Sırayı İlerlet
            nextTurn(room);
            if (skipNext) nextTurn(room);

            updateGameState(roomId);
        }
    });

    // Kart Çekme
    socket.on('drawCard', () => {
        const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
        const room = rooms.get(roomId);
        if (!room || room.players[room.turnIndex].id !== socket.id) return;

        drawCards(room, room.players[room.turnIndex], 1);
        nextTurn(room); // Kart çekince sıra geçer (basitleştirilmiş kural)
        updateGameState(roomId);
    });

    // Ayrılma
    socket.on('disconnect', () => {
        rooms.forEach((room, roomId) => {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                } else {
                    io.to(roomId).emit('playerLeft', room.players);
                    // Oyun sırasındaysa oyunu bitir
                    if(room.gameState === 'PLAYING') {
                        io.to(roomId).emit('gameOver', { winner: 'Oyun İptal (Oyuncu Ayrıldı)' });
                        rooms.delete(roomId);
                    }
                }
            }
        });
    });
});

function joinRoomLogic(socket, roomId, nickname) {
    const room = rooms.get(roomId);
    if (!room) {
        socket.emit('error', 'Oda bulunamadı');
        return;
    }
    if (room.gameState !== 'LOBBY') {
        socket.emit('error', 'Oyun çoktan başladı');
        return;
    }
    if (room.players.length >= 4) {
        socket.emit('error', 'Oda dolu');
        return;
    }

    socket.join(roomId);
    room.players.push({ id: socket.id, nickname, hand: [] });
    
    // Odayı herkese güncelle
    io.to(roomId).emit('roomUpdate', { 
        roomId, 
        roomName: room.name, 
        players: room.players,
        isHost: room.players[0].id === socket.id
    });
}

function getNextPlayer(room) {
    let nextIndex = room.turnIndex + room.direction;
    if (nextIndex >= room.players.length) nextIndex = 0;
    if (nextIndex < 0) nextIndex = room.players.length - 1;
    return room.players[nextIndex];
}

function nextTurn(room) {
    room.turnIndex += room.direction;
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.turnIndex < 0) room.turnIndex = room.players.length - 1;
}

function drawCards(room, player, count) {
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            // Deste biterse atılanları karıştır (en üstteki hariç)
            const top = room.discardPile.pop();
            room.deck = shuffle(room.discardPile);
            room.discardPile = [top];
        }
        if (room.deck.length > 0) {
            player.hand.push(room.deck.pop());
        }
    }
}

function updateGameState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            socket.emit('gameState', {
                hand: p.hand,
                opponents: room.players.filter(x => x.id !== p.id).map(x => ({ 
                    nickname: x.nickname, 
                    cardCount: x.hand.length 
                })),
                topCard: room.discardPile[room.discardPile.length - 1],
                currentColor: room.currentColor,
                isMyTurn: room.players[room.turnIndex].id === p.id,
                turnPlayerName: room.players[room.turnIndex].nickname
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda aktif`));
