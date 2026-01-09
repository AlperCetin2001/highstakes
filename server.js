/* UNO PRO SERVER - FINAL FIXED EDITION */
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

const CARD_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const COLORS = ['red', 'blue', 'green', 'yellow'];

class GameRoom {
    constructor(id, settings = {}) {
        this.id = id;
        this.players = []; 
        this.deck = [];
        this.discardPile = [];
        this.turnIndex = 0;
        this.direction = 1;
        this.gameState = 'LOBBY'; 
        this.settings = settings;
        this.pendingChallenge = null;
        this.unoCallers = new Set();
    }

    createDeck() {
        this.deck = [];
        COLORS.forEach(color => {
            this.deck.push({ color, value: '0', type: 'number', id: Math.random().toString(36) });
            for (let i = 0; i < 2; i++) {
                for (let v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2']) {
                    this.deck.push({ color, value: v, type: v.length > 1 ? 'action' : 'number', id: Math.random().toString(36) });
                }
            }
        });
        for (let i = 0; i < 4; i++) {
            this.deck.push({ color: 'black', value: 'wild', type: 'wild', id: Math.random().toString(36) });
            this.deck.push({ color: 'black', value: 'draw4', type: 'wild', id: Math.random().toString(36) });
        }
        this.shuffle();
    }

    shuffle() {
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
                } else break; 
            }
            cards.push(this.deck.pop());
        }
        return cards;
    }

    calculateScore(winner) {
        let total = 0;
        this.players.forEach(p => {
            if (p.id !== winner.id) {
                p.hand.forEach(c => {
                    if (!isNaN(c.value)) total += parseInt(c.value);
                    else if (['skip', 'reverse', 'draw2'].includes(c.value)) total += 20;
                    else total += 50;
                });
            }
        });
        return total;
    }
}

const rooms = {};

// Oda Listesini Herkese Yayınla
function broadcastRoomList() {
    const list = Object.values(rooms)
        .filter(r => r.gameState === 'LOBBY')
        .map(r => ({ id: r.id, count: r.players.length, host: r.players[0]?.nickname }));
    io.emit('roomList', list);
}

io.on('connection', (socket) => {
    
    // İlk bağlanan listeyi görsün
    socket.emit('roomList', Object.values(rooms).filter(r => r.gameState === 'LOBBY').map(r => ({ id: r.id, count: r.players.length, host: r.players[0]?.nickname })));

    socket.on('createRoom', ({ nickname, avatar }) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = new GameRoom(roomId);
        room.players.push({ id: socket.id, nickname, avatar, hand: [], score: 0, isHost: true });
        rooms[roomId] = room;
        socket.join(roomId);
        
        io.to(roomId).emit('lobbyUpdate', { players: room.players, roomId, isHost: true });
        broadcastRoomList();
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('notification', { type: 'error', text: 'Oda yok!' });
        if (room.gameState !== 'LOBBY') return socket.emit('notification', { type: 'error', text: 'Oyun başlamış!' });
        
        const existing = room.players.find(p => p.id === socket.id);
        if(!existing) {
            room.players.push({ id: socket.id, nickname, avatar, hand: [], score: 0, isHost: false });
            socket.join(roomId);
        }
        
        // Host kim?
        const isHost = room.players[0].id === socket.id;
        io.to(roomId).emit('lobbyUpdate', { players: room.players, roomId, isHost });
        broadcastRoomList();
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.players.length < 2) return socket.emit('notification', { type: 'error', text: 'En az 2 kişi lazım!' });
        
        room.gameState = 'PLAYING';
        room.createDeck();
        room.players.forEach(p => p.hand = room.draw(7));

        let firstCard = room.draw(1)[0];
        while (firstCard.color === 'black') {
            room.deck.push(firstCard);
            room.shuffle();
            firstCard = room.draw(1)[0];
        }
        room.discardPile.push(firstCard);

        if (firstCard.value === 'reverse') {
            room.direction *= -1;
            room.turnIndex = room.players.length - 1;
        } else if (firstCard.value === 'skip') {
            room.turnIndex = 1;
        }

        io.to(roomId).emit('gameStarted');
        updateGameState(roomId);
        broadcastRoomList(); // Oyun başlayınca listeden düşsün
    });

    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.turnIndex) return;

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];
        const previousColor = topCard.displayColor || topCard.color;

        let isValid = false;
        if (card.color === 'black') isValid = true;
        else if (card.color === previousColor || card.value === topCard.value) isValid = true;

        if (!isValid) return socket.emit('notification', {type:'error', text:'Geçersiz Hamle'});

        if (card.value === 'draw4') {
            player.hand.splice(cardIndex, 1);
            card.displayColor = chosenColor;
            room.discardPile.push(card);
            room.gameState = 'CHALLENGE_WAITING';
            const victimIndex = getNextPlayerIndex(room);
            room.pendingChallenge = {
                attackerId: player.id,
                victimId: room.players[victimIndex].id,
                cardPlayed: card,
                prevColor: previousColor
            };
            updateGameState(roomId);
            return;
        }

        player.hand.splice(cardIndex, 1);
        if (card.color === 'black') card.displayColor = chosenColor;
        room.discardPile.push(card);
        handleCardEffect(room, card);
    });

    socket.on('respondChallenge', ({ roomId, action }) => {
        const room = rooms[roomId];
        if(!room) return;
        const { attackerId, victimId, prevColor } = room.pendingChallenge;
        if(socket.id !== victimId) return;

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (action === 'accept') {
            victim.hand.push(...room.draw(4));
            room.turnIndex = getNextPlayerIndex(room);
        } else {
            const hasColor = attacker.hand.some(c => c.color === prevColor);
            if (hasColor) attacker.hand.push(...room.draw(4));
            else {
                victim.hand.push(...room.draw(6));
                room.turnIndex = getNextPlayerIndex(room);
            }
        }
        room.gameState = 'PLAYING';
        room.pendingChallenge = null;
        advanceTurn(room);
        updateGameState(roomId);
    });

    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.turnIndex) return;
        player.hand.push(...room.draw(1));
        updateGameState(roomId);
    });

    socket.on('passTurn', (roomId) => {
        const room = rooms[roomId];
        if(room) { advanceTurn(room); updateGameState(roomId); }
    });

    socket.on('callUno', (roomId) => {
        const room = rooms[roomId];
        if(room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if(p && p.hand.length <= 2) {
                room.unoCallers.add(p.id);
                io.to(roomId).emit('notification', {type:'success', text:`${p.nickname}: UNO!!!`});
            }
        }
    });

    function handleCardEffect(room, card) {
        const player = room.players[room.turnIndex];
        if (player.hand.length === 0) {
            io.to(room.id).emit('gameOver', { winner: player, points: room.calculateScore(player) });
            delete rooms[room.id];
            broadcastRoomList();
            return;
        }
        if (card.value === 'skip') advanceTurn(room);
        else if (card.value === 'reverse') {
            room.direction *= -1;
            if (room.players.length === 2) advanceTurn(room);
        } else if (card.value === 'draw2') {
            const nextP = getNextPlayerIndex(room);
            room.players[nextP].hand.push(...room.draw(2));
            advanceTurn(room);
        }
        advanceTurn(room);
        updateGameState(room.id);
    }

    function advanceTurn(room) {
        room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }
    function getNextPlayerIndex(room) {
        return (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }
    function updateGameState(roomId) {
        const room = rooms[roomId];
        room.players.forEach((p, i) => {
            io.to(p.id).emit('gameState', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                isMyTurn: i === room.turnIndex && room.gameState === 'PLAYING',
                turnIndex: room.turnIndex,
                gameState: room.gameState,
                challengeData: room.pendingChallenge,
                players: room.players.map(pl => ({ 
                    id: pl.id, nickname: pl.nickname, avatar: pl.avatar, cardCount: pl.hand.length, isUno: room.unoCallers.has(pl.id)
                }))
            });
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Fixed Server Ready'));
