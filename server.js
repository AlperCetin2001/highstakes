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
    
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, name: r.name, count: r.players.length, status: r.gameState 
        }));
        socket.emit('roomList', list);
    });

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
            timer: null,
            turnDeadline: 0,
            messages: []
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error', 'Oda bulunamadı.');

        if (room.gameState === 'PLAYING') {
            const joinerData = { id: socket.id, nickname, avatar };
            io.to(room.hostId).emit('joinRequest', joinerData);
            socket.emit('notification', { msg: 'Oda sahibine istek gönderildi...', type: 'info' });
        } else {
            joinRoomHandler(socket, roomId, nickname, avatar);
        }
    });

    socket.on('handleJoinRequest', ({ joinerId, accept }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        const joinerSocket = io.sockets.sockets.get(joinerId);

        if (!room || !joinerSocket) return;

        if (accept) {
            joinerSocket.join(roomId);
            const newPlayer = { 
                id: joinerId, 
                nickname: joinerSocket.handshake.query.nickname || 'Misafir', 
                avatar: '👤',
                hand: [],
                score: 0 
            };
            
            if (room.deck.length < 7) {
                if (room.discardPile.length > 1) {
                    const top = room.discardPile.pop();
                    room.deck = shuffle(room.discardPile);
                    room.discardPile = [top];
                }
            }
            newPlayer.hand = room.deck.length >= 7 ? room.deck.splice(0, 7) : [];
            
            room.players.push(newPlayer);
            addLog(room, `Yeni oyuncu katıldı!`);
            broadcastGameState(roomId);
        } else {
            joinerSocket.emit('error', 'Katılım reddedildi.');
        }
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
        
        // RASTGELE BAŞLANGIÇ (Fix)
        room.turnIndex = Math.floor(Math.random() * room.players.length);
        
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        
        room.players.forEach(p => { p.hand = room.deck.splice(0, 7); });

        let first;
        do { first = room.deck.pop(); } while (first.color === 'black');
        
        room.discardPile.push(first);
        room.currentColor = first.color;
        
        addLog(room, "Oyun Başladı! Sıra rastgele belirlendi.");
        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    // --- SOHBET SİSTEMİ (Yeni) ---
    socket.on('chatMessage', ({ message, targetId }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;

        const sender = room.players.find(p => p.id === socket.id);
        if(!sender) return;

        const msgData = {
            sender: sender.nickname,
            text: message,
            type: targetId === 'all' ? 'global' : 'private',
            time: new Date().toLocaleTimeString()
        };

        if (targetId === 'all') {
            io.to(roomId).emit('chatUpdate', msgData);
        } else {
            // Özel mesaj (Hem gönderene hem alıcıya)
            io.to(targetId).emit('chatUpdate', msgData);
            socket.emit('chatUpdate', { ...msgData, type: 'private-sent', to: targetId }); 
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const top = room.discardPile[room.discardPile.length - 1];
        
        let isValid = false;
        if (card.color === 'black') isValid = true;
        else if (card.color === room.currentColor) isValid = true;
        else if (card.value === top.value) isValid = true;

        if (isValid) {
            clearRoomTimer(room); // Eski timer'ı temizle
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            // --- UNO CEZA KONTROLÜ (Otomatik) ---
            // Kural: Kartı attıktan sonra elinde 1 kart kaldıysa ve ÖNCESİNDE Uno dememişse ceza yer.
            // Uno demek: 'callUno' eventini tetikleyip 'unoCallers' setine girmek.
            if (player.hand.length === 1) {
                if (!room.unoCallers.has(player.id)) {
                    addLog(room, `🚨 ${player.nickname} UNO demeyi unuttu! (+2 Ceza)`);
                    drawCards(room, player, 2);
                    io.to(roomId).emit('notification', { msg: `${player.nickname} UNO demeyi unuttu!`, type: 'error' });
                }
            }
            // Eli değiştiği için Uno durumunu temizle (veya 1 kartı kaldıysa koru)
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(card)}`);
            handleCardEffect(room, card, player, oldColorForChallenge);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;

        clearRoomTimer(room);
        drawCards(room, room.players[room.turnIndex], 1);
        addLog(room, `${room.players[room.turnIndex].nickname} kart çekti.`);
        advanceTurn(room);
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        // Elinde 2 kart varken (biri atılacak) veya 1 kart varken basabilir
        if (player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            io.to(roomId).emit('notification', { msg: `${player.nickname} UNO dedi!`, type: 'warning' });
            io.to(roomId).emit('playSound', 'uno');
            broadcastGameState(roomId);
        }
    });

    socket.on('challengeDecision', ({ decision }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;

        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if (socket.id !== victimId) return;

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (decision === 'accept') {
            addLog(room, `${victim.nickname} +4'ü kabul etti.`);
            drawCards(room, victim, 4);
            advanceTurn(room); // Sıra mağdurdan sonrakine geçer (Mağdur oynamaz)
        } else {
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                addLog(room, `⚖️ BLÖF YAKALANDI! ${attacker.nickname} 4 kart çekiyor.`);
                drawCards(room, attacker, 4);
                // Sıra mağdurda kalır (Avantaj) - Ama discard'da +4 var, mağdur oynayacak.
                // Turn index değiştirmiyoruz (Mağdur oynasın).
            } else {
                addLog(room, `⚖️ TEMİZ! ${attacker.nickname} dürüsttü. ${victim.nickname} 6 kart çekiyor.`);
                drawCards(room, victim, 6);
                advanceTurn(room);
            }
        }

        room.pendingChallenge = null;
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('playCards', ({ cardIndices, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        cardIndices.sort((a, b) => b - a);
        const cardsToPlay = cardIndices.map(idx => player.hand[idx]);
        const firstCard = cardsToPlay[cardsToPlay.length - 1];
        const top = room.discardPile[room.discardPile.length - 1];

        const allSameValue = cardsToPlay.every(c => c.value === firstCard.value);
        if (!allSameValue) return socket.emit('error', 'Sadece aynı değer!');
        
        let isFirstValid = (firstCard.color === 'black') || (firstCard.color === room.currentColor) || (firstCard.value === top.value);
        if (!isFirstValid) return socket.emit('error', 'Uyumsuz kart.');

        clearRoomTimer(room);
        cardIndices.forEach(idx => player.hand.splice(idx, 1));
        cardsToPlay.forEach(c => room.discardPile.push(c));
        
        const lastPlayed = cardsToPlay[0];
        room.currentColor = (lastPlayed.color === 'black') ? chosenColor : lastPlayed.color;
        
        // Çoklu kartta da UNO kontrolü
        if (player.hand.length === 1 && !room.unoCallers.has(player.id)) {
             addLog(room, `🚨 ${player.nickname} UNO demeyi unuttu! +2 Ceza!`);
             drawCards(room, player, 2);
        }
        if (player.hand.length !== 1) room.unoCallers.delete(player.id);

        addLog(room, `${player.nickname} ${cardsToPlay.length} kart birden attı!`);
        handleCardEffect(room, lastPlayed, player, null);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) {
                clearRoomTimer(room);
                rooms.delete(roomId);
            } else {
                if(room.hostId === socket.id) room.hostId = room.players[0].id;
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MANTIĞI ---

function handleCardEffect(room, card, player, oldColorForChallenge) {
    let skipNext = false;

    if (card.value === 'skip') { 
        skipNext = true; 
        addLog(room, "Sıra atladı!"); 
    } 
    else if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) { skipNext = true; } 
    }
    else if (card.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`);
        skipNext = true; 
    }
    else if (card.value === 'wild4') {
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        
        room.pendingChallenge = { 
            attackerId: player.id, 
            victimId: nextPlayer.id, 
            oldColor: oldColorForChallenge 
        };
        
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; 
    }

    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    advanceTurn(room);
    if (skipNext) advanceTurn(room);
    broadcastGameState(room.id);
    startTurnTimer(room);
}

// Timer'ı güvenli başlatma
function startTurnTimer(room) {
    clearRoomTimer(room); // Öncekini temizle
    room.turnDeadline = Date.now() + 60000;
    
    room.timer = setTimeout(() => {
        // Oda hala var mı kontrol et
        if (!rooms.has(room.id)) return;
        
        const currentPlayer = room.players[room.turnIndex];
        if (currentPlayer) {
            drawCards(room, currentPlayer, 1);
            addLog(room, `${currentPlayer.nickname} süre doldu.`);
            advanceTurn(room);
            broadcastGameState(room.id);
            startTurnTimer(room);
        }
    }, 60000);
}

// Timer'ı güvenli temizleme
function clearRoomTimer(room) {
    if(room.timer) {
        clearTimeout(room.timer);
        room.timer = null;
    }
}

function finishGame(room, winner) {
    clearRoomTimer(room);
    let totalScore = 0;
    room.players.forEach(p => { p.hand.forEach(c => totalScore += c.score); });
    
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        score: totalScore,
        players: room.players
    });

    setTimeout(() => {
        if(rooms.has(room.id)) { // Oda silinmediyse
            room.gameState = 'LOBBY';
            room.players.forEach(p => {
                p.hand = [];
                p.cardCount = 0;
                p.hasUno = false;
            });
            room.deck = [];
            room.discardPile = [];
            room.pendingChallenge = null;
            broadcastGameState(room.id);
        }
    }, 8000);
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
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function getNextPlayerIndex(room) {
    return (room.turnIndex + room.direction + room.players.length) % room.players.length;
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
                turnDeadline: room.turnDeadline,
                pendingChallenge: !!room.pendingChallenge
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO IMMORTAL SERVER READY'));
