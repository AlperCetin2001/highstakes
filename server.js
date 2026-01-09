/* UNO ELITE SERVER */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/', (req, res) => res.send('UNO ELITE SERVER ONLINE'));

// --- OYUN VERİ YAPILARI ---
const COLORS = ['red', 'blue', 'green', 'yellow'];
class GameRoom {
    constructor(id, settings) {
        this.id = id;
        this.players = []; // {id, nickname, avatar, hand, socket}
        this.deck = [];
        this.discardPile = [];
        this.turnIndex = 0;
        this.direction = 1;
        this.gameState = 'LOBBY'; 
        this.settings = settings || {};
        this.maxPlayers = 4;
    }

    createDeck() {
        this.deck = [];
        COLORS.forEach(c => {
            this.deck.push({ color: c, value: '0', id: Math.random() });
            for(let i=0;i<2;i++) ['1','2','3','4','5','6','7','8','9','skip','reverse','draw2'].forEach(v => {
                this.deck.push({ color: c, value: v, type: v.length>1?'action':'num', id: Math.random() });
            });
        });
        for(let i=0;i<4;i++) {
            this.deck.push({ color: 'black', value: 'wild', id: Math.random() });
            this.deck.push({ color: 'black', value: 'draw4', id: Math.random() });
        }
        this.shuffle();
    }

    shuffle() { this.deck.sort(() => Math.random() - 0.5); }

    draw(n) {
        let cards = [];
        for(let i=0; i<n; i++) {
            if(this.deck.length===0) {
                if(this.discardPile.length>1) {
                    let top = this.discardPile.pop();
                    this.deck = this.discardPile;
                    this.discardPile = [top];
                    this.shuffle();
                } else break;
            }
            cards.push(this.deck.pop());
        }
        return cards;
    }
}

const rooms = {};

io.on('connection', (socket) => {
    
    socket.on('getRooms', () => {
        // Kodları GİZLE, sadece ID ve doluluk gönder
        const list = Object.values(rooms)
            .filter(r => r.gameState === 'LOBBY')
            .map(r => ({ id: r.id, count: r.players.length, max: r.maxPlayers }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar }) => {
        const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
        const room = new GameRoom(roomId, {});
        room.players.push({ id: socket.id, nickname, avatar, hand: [] });
        rooms[roomId] = room;
        socket.join(roomId);
        sendRoomUpdate(roomId);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms[roomId];
        if(!room || room.gameState !== 'LOBBY' || room.players.length >= 4) {
            return socket.emit('notification', {type:'error', text:'Oda dolu veya oyun başladı!'});
        }
        room.players.push({ id: socket.id, nickname, avatar, hand: [] });
        socket.join(roomId);
        sendRoomUpdate(roomId);
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if(!room || room.players.length < 2) return; // 2 kişiden azsa başlama
        
        room.gameState = 'PLAYING';
        room.createDeck();
        room.players.forEach(p => p.hand = room.draw(7));
        
        let start = room.draw(1)[0];
        while(start.color==='black') { room.deck.push(start); room.shuffle(); start=room.draw(1)[0]; }
        room.discardPile.push(start);
        
        io.to(roomId).emit('gameStarted');
        sendGameState(roomId);
    });

    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if(!room) return;
        const p = room.players.find(x => x.id === socket.id);
        if(room.players.indexOf(p) !== room.turnIndex) return;

        const card = p.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length-1];
        const col = top.displayColor || top.color;

        if(card.color === 'black' || card.color === col || card.value === top.value) {
            p.hand.splice(cardIndex, 1);
            if(card.color === 'black') card.displayColor = chosenColor;
            room.discardPile.push(card);
            
            // Efektler
            if(card.value === 'skip') advance(room);
            if(card.value === 'reverse') { room.direction *= -1; if(room.players.length===2) advance(room); }
            if(card.value === 'draw2') { 
                let n = nextIdx(room); room.players[n].hand.push(...room.draw(2)); advance(room); 
            }
            if(card.value === 'draw4') { 
                let n = nextIdx(room); room.players[n].hand.push(...room.draw(4)); advance(room); 
            }

            if(p.hand.length === 0) {
                io.to(roomId).emit('gameOver', p.nickname);
                delete rooms[roomId];
                return;
            }
            advance(room);
            sendGameState(roomId);
        }
    });

    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if(!room) return;
        const p = room.players.find(x => x.id === socket.id);
        if(room.players.indexOf(p) !== room.turnIndex) return;
        p.hand.push(...room.draw(1));
        sendGameState(roomId);
    });

    function advance(r) { r.turnIndex = (r.turnIndex + r.direction + r.players.length) % r.players.length; }
    function nextIdx(r) { return (r.turnIndex + r.direction + r.players.length) % r.players.length; }

    function sendRoomUpdate(rid) {
        const r = rooms[rid];
        io.to(rid).emit('roomUpdate', {
            id: r.id,
            players: r.players.map(p => ({id:p.id, nickname:p.nickname, avatar:p.avatar})),
            isHost: r.players[0].id, // Host ID'sini gönder
            canStart: r.players.length >= 2
        });
        io.emit('roomList', Object.values(rooms).filter(x=>x.gameState==='LOBBY').map(x=>({id:x.id, count:x.players.length, max:4})));
    }

    function sendGameState(rid) {
        const r = rooms[rid];
        r.players.forEach((p, i) => {
            io.to(p.id).emit('gameState', {
                hand: p.hand,
                topCard: r.discardPile[r.discardPile.length-1],
                turnIndex: r.turnIndex,
                myIndex: i, // Oyuncunun masadaki gerçek indexi
                players: r.players.map(x => ({ id: x.id, nickname: x.nickname, avatar: x.avatar, count: x.hand.length }))
            });
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server Ready'));
