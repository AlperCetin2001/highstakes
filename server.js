const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static(path.join(__dirname, '.')));

// Oyun Durumu
const rooms = new Map();
const players = new Map();

// Yardımcı Fonksiyonlar
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
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
        for (let i = 0; i < 4; i++) deck.push({ color: 'black', value: type, type });
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
    for (let i = 0; i < numPlayers; i++) hands.push(deck.splice(0, 7));
    return hands;
}

// Socket.io Events
io.on('connection', (socket) => {
    console.log('🔗 Yeni bağlantı:', socket.id);
    
    players.set(socket.id, {
        socketId: socket.id,
        roomId: null,
        nickname: 'Anonim',
        avatar: '👤',
        score: 0,
        isReady: false,
        isHost: false
    });

    socket.emit('welcome', { message: 'UNO PRO Sunucusuna Hoş Geldin!' });

    socket.on('getRooms', () => {
        const roomList = Array.from(rooms.values()).map(room => ({
            id: room.id,
            name: room.name,
            playerCount: room.players.length,
            maxPlayers: 4
        }));
        socket.emit('roomList', roomList);
    });

    socket.on('createRoom', (data, callback) => {
        const player = players.get(socket.id);
        if (!player) return callback({ success: false, error: 'Oyuncu hatası' });
        
        const roomId = generateRoomCode();
        const room = {
            id: roomId,
            name: data.roomName || `${data.nickname}'in Odası`,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            currentPlayerIndex: 0,
            direction: 1
        };
        
        player.nickname = data.nickname;
        player.avatar = data.avatar;
        player.roomId = roomId;
        player.isHost = true;
        
        room.players.push({
            id: socket.id,
            nickname: player.nickname,
            avatar: player.avatar,
            score: 0,
            isHost: true,
            isReady: false,
            isCurrentTurn: false,
            cardCount: 0,
            hasUno: false,
            hand: []
        });
        
        rooms.set(roomId, room);
        socket.join(roomId);
        
        callback({ success: true, roomId });
        io.emit('roomList', Array.from(rooms.values()).map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, maxPlayers: 4 })));
    });

    socket.on('joinRoom', (data, callback) => {
        const player = players.get(socket.id);
        const room = rooms.get(data.roomId);
        
        if (!room) return callback({ success: false, error: 'Oda bulunamadı' });
        if (room.players.length >= 4) return callback({ success: false, error: 'Oda dolu' });
        if (room.gameState !== 'LOBBY') return callback({ success: false, error: 'Oyun zaten başlamış' });
        
        player.nickname = data.nickname;
        player.avatar = data.avatar;
        player.roomId = room.id;
        
        room.players.push({
            id: socket.id,
            nickname: player.nickname,
            avatar: player.avatar,
            score: 0,
            isHost: false,
            isReady: false,
            isCurrentTurn: false,
            cardCount: 0,
            hasUno: false,
            hand: []
        });
        
        socket.join(room.id);
        
        io.to(room.id).emit('roomUpdate', {
            roomId: room.id,
            roomName: room.name,
            players: room.players,
            canStart: room.players.length >= 2 && room.players.every(p => p.isReady)
        });
        
        callback({ success: true });
        io.emit('roomList', Array.from(rooms.values()).map(r => ({ id: r.id, name: r.name, playerCount: r.players.length, maxPlayers: 4 })));
    });

    socket.on('toggleReady', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        const room = rooms.get(player.roomId);
        
        const roomPlayer = room.players.find(p => p.id === socket.id);
        if (roomPlayer) {
            roomPlayer.isReady = data.isReady;
            io.to(room.id).emit('playerReady', { playerId: socket.id, isReady: data.isReady });
            
            const canStart = room.players.length >= 2 && room.players.every(p => p.isReady);
            io.to(room.id).emit('roomUpdate', { roomId: room.id, roomName: room.name, players: room.players, canStart });
        }
    });

    socket.on('startGame', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        const room = rooms.get(player.roomId);
        if (!room || !player.isHost) return;

        room.gameState = 'PLAYING';
        room.deck = createDeck();
        room.discardPile = [];
        room.direction = 1;
        room.currentPlayerIndex = 0; // Host starts first usually

        const hands = dealCards(room.deck, room.players.length);
        room.players.forEach((p, i) => {
            p.hand = hands[i];
            p.cardCount = p.hand.length;
            p.isCurrentTurn = (i === 0);
            p.hasUno = false;
        });

        // İlk kart (Joker olmamalı)
        let firstCard;
        do {
            firstCard = room.deck.pop();
        } while (firstCard.color === 'black' || firstCard.type !== 'number');
        
        room.topCard = firstCard;
        room.discardPile.push(firstCard);

        io.to(room.id).emit('gameStarted', { players: room.players });
        updateGameState(room);
    });

    socket.on('playCard', (data) => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        const room = rooms.get(player.roomId);
        
        const roomPlayer = room.players.find(p => p.id === socket.id);
        if (!room || !roomPlayer.isCurrentTurn) return;

        const card = roomPlayer.hand[data.cardIndex];
        
        // Renk değişimi (Wild)
        if (card.color === 'black' && data.chosenColor) {
            card.displayColor = data.chosenColor;
        }

        // Kart geçerli mi?
        if (!isValidPlay(card, room.topCard)) {
            return socket.emit('notification', { text: 'Bu kartı oynayamazsın!', type: 'warning' });
        }

        // Kartı elden çıkar
        roomPlayer.hand.splice(data.cardIndex, 1);
        roomPlayer.cardCount = roomPlayer.hand.length;
        room.topCard = card;
        room.discardPile.push(card);

        // UNO Kontrolü
        if (roomPlayer.cardCount === 1 && !roomPlayer.hasUno) {
            // UNO demeyi unuttu cezası
            // Basitleştirme: Otomatik UNO demiyor, oyuncunun butona basması lazım.
            // Burada ceza vermiyoruz, callUno event'ine bırakıyoruz.
        } else if (roomPlayer.cardCount === 0) {
            handlePlayerWin(room, roomPlayer);
            return;
        }

        io.to(room.id).emit('notification', { text: `${roomPlayer.nickname} oynadı: ${getCardDisplay(card)}`, type: 'info' });

        // Özel Kart Etkileri ve Sıra Geçişi
        handleTurnProgression(room, card);
        updateGameState(room);
    });

    socket.on('drawCard', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        const room = rooms.get(player.roomId);
        const roomPlayer = room.players.find(p => p.id === socket.id);

        if (!roomPlayer.isCurrentTurn) return;

        drawCards(room, roomPlayer, 1);
        
        const drawnCard = roomPlayer.hand[roomPlayer.hand.length - 1];
        
        if (isValidPlay(drawnCard, room.topCard)) {
            socket.emit('notification', { text: 'Çektiğin kartı oynayabilirsin.', type: 'info' });
            // Oyuncu oynayabilir, sıra onda kalır.
        } else {
            moveToNextPlayer(room);
        }
        updateGameState(room);
    });

    socket.on('passTurn', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        const room = rooms.get(player.roomId);
        if (room && room.players.find(p => p.id === socket.id)?.isCurrentTurn) {
            moveToNextPlayer(room);
            updateGameState(room);
        }
    });

    socket.on('callUno', () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) return;
        const room = rooms.get(player.roomId);
        const roomPlayer = room.players.find(p => p.id === socket.id);
        
        if (roomPlayer && roomPlayer.cardCount === 1) {
            roomPlayer.hasUno = true;
            io.to(room.id).emit('notification', { text: `${roomPlayer.nickname} UNO dedi!`, type: 'success' });
            updateGameState(room);
        }
    });

    socket.on('leaveRoom', () => {
        handleDisconnect(socket);
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });
});

function handleDisconnect(socket) {
    const player = players.get(socket.id);
    if (player && player.roomId) {
        const room = rooms.get(player.roomId);
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                rooms.delete(room.id);
            } else {
                if (player.isHost) {
                    room.players[0].isHost = true; // Yeni host
                }
                io.to(room.id).emit('roomUpdate', { roomId: room.id, players: room.players });
                io.to(room.id).emit('playerLeft', { playerId: socket.id });
                
                // Oyun sırasında biri çıkarsa oyunu lobiye döndür
                if (room.gameState === 'PLAYING') {
                    room.gameState = 'LOBBY';
                    io.to(room.id).emit('notification', { text: 'Bir oyuncu ayrıldı, oyun sonlandırıldı.', type: 'error' });
                    io.to(room.id).emit('roomUpdate', { roomId: room.id, players: room.players, canStart: false });
                }
            }
        }
    }
    players.delete(socket.id);
}

function isValidPlay(card, topCard) {
    if (card.color === 'black') return true;
    if (card.color === (topCard.displayColor || topCard.color)) return true;
    if (card.value === topCard.value) return true;
    return false;
}

function handleTurnProgression(room, card) {
    let skipNext = false;

    if (card.type === 'reverse') {
        room.direction *= -1;
        // 2 kişiyken reverse, skip gibi davranır
        if (room.players.length === 2) {
            skipNext = true;
        }
    } else if (card.type === 'skip') {
        skipNext = true;
    } else if (card.type === 'draw-two') {
        const nextIndex = getNextPlayerIndex(room);
        drawCards(room, room.players[nextIndex], 2);
        skipNext = true; // Kart çeken oyuncu sırasını kaybeder
    } else if (card.type === 'wild-draw-four') {
        const nextIndex = getNextPlayerIndex(room);
        drawCards(room, room.players[nextIndex], 4);
        skipNext = true; // Kart çeken oyuncu sırasını kaybeder
    }

    moveToNextPlayer(room); // Normal geçiş
    if (skipNext) {
        moveToNextPlayer(room); // Skip veya ceza yiyeni atla
    }
}

function getNextPlayerIndex(room) {
    return (room.currentPlayerIndex + room.direction + room.players.length) % room.players.length;
}

function moveToNextPlayer(room) {
    room.players[room.currentPlayerIndex].isCurrentTurn = false;
    room.currentPlayerIndex = getNextPlayerIndex(room);
    room.players[room.currentPlayerIndex].isCurrentTurn = true;
}

function drawCards(room, player, count) {
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            if (room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = shuffleArray(room.discardPile);
                room.discardPile = [top];
            } else {
                break; // Kart kalmadı
            }
        }
        player.hand.push(room.deck.pop());
    }
    player.cardCount = player.hand.length;
}

function updateGameState(room) {
    room.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.id);
        if (socket) {
            // Sadece kendi elini görsün, diğerlerinin sadece kart sayısını
            const cleanPlayers = room.players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                avatar: p.avatar,
                score: p.score,
                cardCount: p.cardCount,
                isCurrentTurn: p.isCurrentTurn,
                hasUno: p.hasUno,
                isHost: p.isHost,
                isReady: p.isReady
            }));

            socket.emit('gameState', {
                hand: player.hand,
                topCard: room.topCard,
                isMyTurn: player.isCurrentTurn,
                gameState: room.gameState,
                players: cleanPlayers,
                direction: room.direction
            });
        }
    });
}

function handlePlayerWin(room, winner) {
    room.gameState = 'GAME_OVER';
    // Puan hesaplama
    let score = 0;
    room.players.forEach(p => {
        if (p.id !== winner.id) {
            p.hand.forEach(c => {
                if (c.type === 'number') score += parseInt(c.value);
                else if (c.color === 'black') score += 50;
                else score += 20;
            });
        }
    });
    winner.score += score;

    io.to(room.id).emit('gameOver', {
        winner: { id: winner.id, nickname: winner.nickname, score: winner.score },
        players: room.players
    });
}

function getCardDisplay(card) {
    if (card.color === 'black') return card.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${card.color.toUpperCase()} ${card.value}`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu ${PORT} portunda çalışıyor`);
});
