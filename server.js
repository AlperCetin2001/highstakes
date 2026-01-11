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

const rooms = new Map();

// --- YARDIMCI FONKSİYONLAR ---
function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];

    colors.forEach(color => {
        deck.push({ color, value: '0', type: 'number', score: 0, id: Math.random().toString(36) });
        for (let i = 1; i <= 9; i++) {
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
            deck.push({ color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
        }
        ['skip', 'reverse', 'draw2'].forEach(val => {
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
            deck.push({ color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
        });
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'wild', type: 'wild', score: 50, id: Math.random().toString(36) });
        deck.push({ color: 'black', value: 'wild4', type: 'wild', score: 50, id: Math.random().toString(36) });
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
    
    // Oda Listesi
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values())
            .filter(r => r.gameState === 'LOBBY')
            .map(r => ({ id: r.id, name: r.name, count: r.players.length }));
        socket.emit('roomList', list);
    });

    // Oda Kur
    socket.on('createRoom', ({ nickname, avatar }) => {
        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            timer: null // Zamanlayıcı
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) {
            socket.emit('error', 'En az 2 oyuncu gerekli!');
            return;
        }

        room.gameState = 'PLAYING';
        room.deck = createDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0;
        room.unoCallers.clear();
        room.logs = [];
        
        // Eli dağıt
        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); });

        // İlk kart (Wild olmamalı)
        let first;
        do { first = room.deck.pop(); } while (first.color === 'black');
        
        room.discardPile.push(first);
        room.currentColor = first.color;
        
        addLog(room, "Oyun Başladı! Bol şans.");
        broadcastGameState(roomId);
        startTurnTimer(room); // Zamanlayıcıyı başlat
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        // Güvenlik kontrolleri
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;
        if (!player.hand[cardIndex]) return; // Geçersiz kart indeksi koruması

        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        
        // Kural Kontrolü
        let isValid = (card.color === 'black') || (card.color === room.currentColor) || (card.value === top.value);
        
        if (isValid) {
            resetTurnTimer(room); // Zamanlayıcıyı sıfırla

            // Kartı elden çıkar
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            // Renk Güncelle
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            // UNO durumu
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} oynadı: ${formatCardName(card)}`);

            // Efektleri Uygula
            handleCardEffect(room, card, player);
        }
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;

        resetTurnTimer(room);
        drawCards(room, room.players[room.turnIndex], 1);
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`);
        advanceTurn(room);
        broadcastGameState(roomId);
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        // Sadece elinde 2 veya 1 kart varken UNO diyebilir
        if (player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            io.to(roomId).emit('notification', { msg: `${player.nickname} UNO dedi!`, type: 'warning' });
            io.to(roomId).emit('playSound', 'uno'); // Ses efekti
            broadcastGameState(roomId);
        }
    });

    // +4 Meydan Okuma Yanıtı
    socket.on('challengeDecision', ({ decision }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;

        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if (socket.id !== victimId) return;

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (decision === 'accept') {
            addLog(room, `${victim.nickname} cezayı kabul etti.`);
            drawCards(room, victim, 4);
        } else {
            // Blöf kontrolü: Attacker'ın elinde eski renkten kart var mı? (Wild hariç)
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                addLog(room, `⚖️ BAŞARILI! ${attacker.nickname} blöf yaptı!`);
                drawCards(room, attacker, 4);
            } else {
                addLog(room, `⚖️ BAŞARISIZ! ${attacker.nickname} dürüsttü.`);
                drawCards(room, victim, 6);
            }
        }

        room.pendingChallenge = null;
        advanceTurn(room);
        broadcastGameState(roomId);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) {
                if(room.timer) clearTimeout(room.timer);
                rooms.delete(roomId);
            } else {
                if(room.hostId === socket.id) room.hostId = room.players[0].id;
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MANTIĞI ---

function handleCardEffect(room, card, player) {
    let skipTurn = false;

    if (card.value === 'skip') { skipTurn = true; addLog(room, "Sıra atladı!"); } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) { skipTurn = true; }
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`);
        skipTurn = true;
    }
    else if (card.value === 'wild4') {
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        // Meydan okuma için eski rengi kaydetmemiz lazım ama burada basitleştiriyoruz
        // Gerçek kurallarda +4 atıldığı andaki renk önemlidir.
        // Hile kontrolü için "black" olmayan herhangi bir renk eşleşmesi kontrol edilecek.
        room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor: room.currentColor };
        
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; // Tur ilerlemez, yanıt beklenir
    }

    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    advanceTurn(room);
    if (skipTurn) advanceTurn(room);
    broadcastGameState(room.id);
    startTurnTimer(room);
}

// 30 Saniye AFK Zamanlayıcısı
function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => {
        // Süre doldu, oyuncuya kart çektir ve sırayı geçir
        const currentPlayer = room.players[room.turnIndex];
        drawCards(room, currentPlayer, 1);
        addLog(room, `${currentPlayer.nickname} süre aşımı (AFK).`);
        advanceTurn(room);
        broadcastGameState(room.id);
        startTurnTimer(room); // Sonraki oyuncu için başlat
    }, 30000); 
}

function resetTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
}

function finishGame(room, winner) {
    if(room.timer) clearTimeout(room.timer);
    let totalScore = 0;
    room.players.forEach(p => { p.hand.forEach(c => totalScore += c.score); });
    
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        score: totalScore,
        players: room.players
    });

    // 6 saniye sonra lobiye dön
    setTimeout(() => {
        room.gameState = 'LOBBY';
        room.players.forEach(p => {
            p.hand = [];
            p.cardCount = 0;
            p.hasUno = false;
        });
        room.deck = [];
        room.discardPile = [];
        broadcastGameState(room.id);
    }, 6000);
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    
    socket.join(roomId);
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        room.players.push({ id: socket.id, nickname, avatar, hand: [] });
    }
    broadcastGameState(roomId);
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

function getNextPlayerIndex(room) {
    let idx = room.turnIndex + room.direction;
    if (idx >= room.players.length) idx = 0;
    if (idx < 0) idx = room.players.length - 1;
    return idx;
}
function getNextPlayer(room) { return room.players[getNextPlayerIndex(room)]; }

function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}

function addLog(room, msg) {
    room.logs.push(msg);
    if(room.logs.length > 6) room.logs.shift();
}

function formatCardName(c) {
    if(c.color === 'black') return c.value === 'wild' ? 'Joker' : '+4 Joker';
    return `${c.color.toUpperCase()} ${c.value}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id)
                })),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname,
                isMyTurn: room.players[room.turnIndex].id === p.id,
                direction: room.direction // Yön oku için
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Sunucusu Aktif!'));
