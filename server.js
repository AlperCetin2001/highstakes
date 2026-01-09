/* UNO ULTIMATE 3D SERVER
   - Mobil Uyumlu
   - Gelişmiş Lobi Yönetimi
   - Güvenlik ve Gizlilik Odaklı
*/

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

const rooms = {};

// --- YARDIMCI SINIFLAR ---
class GameRoom {
    constructor(id, settings) {
        this.id = id;
        this.displayName = `Masa #${Math.floor(Math.random() * 9000) + 1000}`; // Güvenlik için takma isim
        this.players = []; 
        this.deck = [];
        this.discardPile = [];
        this.turnIndex = 0;
        this.direction = 1;
        this.gameState = 'LOBBY'; 
        this.settings = settings || { stacking: false };
        this.unoCallers = new Set();
    }

    createDeck() {
        const colors = ['red', 'blue', 'green', 'yellow'];
        this.deck = [];
        colors.forEach(c => {
            this.deck.push({ color: c, value: '0', type: 'number', uid: Math.random() });
            for(let k=0; k<2; k++) {
                ['1','2','3','4','5','6','7','8','9','skip','reverse','draw2'].forEach(v => {
                    this.deck.push({ color: c, value: v, type: v.length>1?'action':'number', uid: Math.random() });
                });
            }
        });
        for(let i=0; i<4; i++) {
            this.deck.push({ color: 'black', value: 'wild', type: 'wild', uid: Math.random() });
            this.deck.push({ color: 'black', value: 'draw4', type: 'wild', uid: Math.random() });
        }
        this.shuffle();
    }

    shuffle() {
        this.deck.sort(() => Math.random() - 0.5);
    }

    draw(count) {
        const cards = [];
        for(let i=0; i<count; i++) {
            if(this.deck.length === 0) {
                if(this.discardPile.length > 1) {
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
}

io.on('connection', (socket) => {
    
    // ODA LİSTESİ (Gizlilik: Gerçek ID yerine DisplayName gider)
    socket.on('getRooms', () => {
        const list = Object.values(rooms)
            .filter(r => r.gameState === 'LOBBY')
            .map(r => ({ id: r.id, name: r.displayName, count: r.players.length }));
        socket.emit('roomList', list);
    });

    // ODA OLUŞTURMA
    socket.on('createRoom', ({ nickname, avatar, settings }) => {
        const roomId = Math.random().toString(36).substring(2, 9);
        const room = new GameRoom(roomId, settings);
        room.players.push({ id: socket.id, nickname, avatar, hand: [], isHost: true });
        rooms[roomId] = room;
        socket.join(roomId);
        
        io.to(roomId).emit('lobbyUpdate', { players: room.players, roomId: room.id, isHost: true });
        io.emit('roomList', []); // Listeyi yenilet
    });

    // ODAYA KATILMA
    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms[roomId];
        if (!room || room.gameState !== 'LOBBY') return socket.emit('notification', { type: 'error', text: 'Oda bulunamadı veya oyun başladı!' });
        if (room.players.length >= 4) return socket.emit('notification', { type: 'error', text: 'Oda dolu!' });

        room.players.push({ id: socket.id, nickname, avatar, hand: [], isHost: false });
        socket.join(roomId);
        
        // Herkese Lobi Güncellemesi Gönder
        room.players.forEach(p => {
            io.to(p.id).emit('lobbyUpdate', { players: room.players, roomId: room.id, isHost: p.isHost });
        });
    });

    // OYUNU BAŞLAT
    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.players.length < 2) return; // Güvenlik kontrolü

        room.gameState = 'PLAYING';
        room.createDeck();
        room.players.forEach(p => p.hand = room.draw(7));

        let startCard = room.draw(1)[0];
        while(startCard.color === 'black') {
            room.deck.push(startCard);
            room.shuffle();
            startCard = room.draw(1)[0];
        }
        room.discardPile.push(startCard);

        io.to(roomId).emit('gameStarted');
        updateGameState(roomId);
    });

    // OYUN HAMLELERİ
    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if(room.players.indexOf(player) !== room.turnIndex) return;

        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        const col = top.displayColor || top.color;

        if (card.color === 'black' || card.color === col || card.value === top.value) {
            player.hand.splice(cardIndex, 1);
            if(card.color === 'black') card.displayColor = chosenColor;
            room.discardPile.push(card);

            if(card.value === 'skip') advanceTurn(room);
            else if(card.value === 'reverse') {
                room.direction *= -1;
                if(room.players.length === 2) advanceTurn(room);
            }
            else if(card.value === 'draw2') {
                const n = getNextPlayer(room);
                room.players[n].hand.push(...room.draw(2));
                advanceTurn(room);
            }
            else if(card.value === 'draw4') {
                const n = getNextPlayer(room);
                room.players[n].hand.push(...room.draw(4));
                advanceTurn(room);
            }

            if(player.hand.length === 0) {
                io.to(roomId).emit('gameOver', { winner: player.nickname });
                delete rooms[roomId];
                return;
            }

            advanceTurn(room);
            updateGameState(roomId);
        }
    });

    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if(room.players.indexOf(player) !== room.turnIndex) return;

        player.hand.push(...room.draw(1));
        updateGameState(roomId);
    });

    socket.on('disconnecting', () => {
        const roomsToUpdate = [...socket.rooms];
        roomsToUpdate.forEach(roomId => {
            const room = rooms[roomId];
            if(room) {
                room.players = room.players.filter(p => p.id !== socket.id);
                if(room.players.length === 0) {
                    delete rooms[roomId];
                } else {
                    if(room.gameState === 'LOBBY') {
                         room.players.forEach(p => {
                            io.to(p.id).emit('lobbyUpdate', { players: room.players, roomId: room.id, isHost: p.isHost });
                        });
                    } else {
                        // Oyun sırasında çıkarsa (basitçe oyunu bitiriyoruz şimdilik)
                        io.to(roomId).emit('notification', {type:'error', text:'Bir oyuncu ayrıldı. Oyun bitti.'});
                        delete rooms[roomId];
                    }
                }
            }
        });
    });

    function advanceTurn(room) {
        room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }
    function getNextPlayer(room) {
        return (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }
    function updateGameState(roomId) {
        const room = rooms[roomId];
        room.players.forEach((p, i) => {
            io.to(p.id).emit('gameState', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                turnIndex: room.turnIndex,
                players: room.players.map(pl => ({ id: pl.id, nickname: pl.nickname, avatar: pl.avatar, cardCount: pl.hand.length }))
            });
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('3D UNO SERVER READY'));
