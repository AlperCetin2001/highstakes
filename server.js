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

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// --- DESTE OLUŞTURMA (MODÜLER) ---

function createClassicDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];
    colors.forEach(color => {
        deck.push(createCardObj(color, '0', 'number', 0));
        for (let i = 1; i <= 9; i++) {
            deck.push(createCardObj(color, i.toString(), 'number', i));
            deck.push(createCardObj(color, i.toString(), 'number', i));
        }
        ['skip', 'reverse', 'draw2'].forEach(val => {
            deck.push(createCardObj(color, val, 'action', 20));
            deck.push(createCardObj(color, val, 'action', 20));
        });
    });
    for (let i = 0; i < 4; i++) {
        deck.push(createCardObj('black', 'wild', 'wild', 50));
        deck.push(createCardObj('black', 'wild4', 'wild', 50));
    }
    return shuffle(deck);
}

function createFlipDeck() {
    const deck = [];
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    const darkColors = ['pink', 'teal', 'orange', 'purple'];
    
    let lightCards = [];
    let darkCards = [];

    // Light Side
    lightColors.forEach(color => {
        lightCards.push({ color, value: '1', type: 'number', score: 1 });
        for(let i=1; i<=9; i++) {
            lightCards.push({ color, value: i.toString(), type: 'number', score: i });
            lightCards.push({ color, value: i.toString(), type: 'number', score: i });
        }
        ['draw1', 'reverse', 'skip'].forEach(val => {
            lightCards.push({ color, value: val, type: 'action', score: 20 });
            lightCards.push({ color, value: val, type: 'action', score: 20 });
        });
        lightCards.push({ color, value: 'flip', type: 'action', score: 20 });
        lightCards.push({ color, value: 'flip', type: 'action', score: 20 });
    });
    for(let i=0; i<4; i++) {
        lightCards.push({ color: 'black', value: 'wild', type: 'wild', score: 40 });
        lightCards.push({ color: 'black', value: 'wild_draw2', type: 'wild', score: 50 });
    }

    // Dark Side
    darkColors.forEach(color => {
        for(let i=1; i<=9; i++) {
            darkCards.push({ color, value: i.toString(), type: 'number', score: i });
            darkCards.push({ color, value: i.toString(), type: 'number', score: i });
        }
        ['draw5', 'reverse', 'skip_everyone'].forEach(val => {
            darkCards.push({ color, value: val, type: 'action', score: 20 });
            darkCards.push({ color, value: val, type: 'action', score: 20 });
        });
        darkCards.push({ color, value: 'flip', type: 'action', score: 20 });
        darkCards.push({ color, value: 'flip', type: 'action', score: 20 });
    });
    for(let i=0; i<4; i++) {
        darkCards.push({ color: 'black', value: 'wild', type: 'wild', score: 40 });
        darkCards.push({ color: 'black', value: 'wild_draw_color', type: 'wild', score: 60 });
    }

    lightCards = shuffle(lightCards);
    darkCards = shuffle(darkCards);

    const minLen = Math.min(lightCards.length, darkCards.length);
    for(let i=0; i<minLen; i++) {
        deck.push({
            id: Math.random().toString(36),
            sides: { light: lightCards[i], dark: darkCards[i] }
        });
    }
    return shuffle(deck);
}

function createCardObj(color, value, type, score) {
    return {
        id: Math.random().toString(36),
        sides: {
            light: { color, value, type, score },
            dark: { color, value, type, score }
        }
    };
}

// --- SOCKET EVENTS ---

io.on('connection', (socket) => {
    
    // Query params
    const q = socket.handshake.query;
    socket.data.nickname = q.nickname || 'Anonim';
    socket.data.avatar = q.avatar || '👤';

    socket.on('getRooms', () => {
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, name: r.name, mode: r.gameMode, count: r.players.length, status: r.gameState 
        }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, gameMode }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;

        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            gameMode: (gameMode === 'flip') ? 'flip' : 'classic',
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentSide: 'light',
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            pendingDrawAction: null,
            timer: null,
            turnDeadline: 0 // Timestamp
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error', 'Oda bulunamadı.');

        const existing = room.players.find(p => p.nickname === nickname);
        if (existing && room.gameState === 'PLAYING') {
             existing.id = socket.id;
             socket.join(roomId);
             broadcastGameState(roomId);
             return;
        }

        if (room.gameState === 'PLAYING') {
            io.to(room.hostId).emit('joinRequest', { id: socket.id, nickname, avatar });
            socket.emit('notification', { msg: 'İstek gönderildi...', type: 'info' });
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
            const nickname = joinerSocket.data.nickname || 'Misafir';
            const avatar = joinerSocket.data.avatar || '👤';
            const newPlayer = { id: joinerId, nickname, avatar, hand: [], score: 0, totalScore: 0 };
            
            if (room.gameState === 'PLAYING') {
                if (room.deck.length < 7) room.deck = (room.gameMode==='flip')?createFlipDeck():createClassicDeck();
                newPlayer.hand = room.deck.splice(0, 7);
            }
            room.players.push(newPlayer);
            broadcastGameState(roomId);
        } else {
            joinerSocket.emit('error', 'Reddedildi.');
        }
    });

    socket.on('startGame', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) return socket.emit('error', 'Yetersiz oyuncu!');

        room.gameState = 'PLAYING';
        room.deck = (room.gameMode === 'flip') ? createFlipDeck() : createClassicDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0;
        room.currentSide = 'light';
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        room.pendingDrawAction = null;
        
        room.players.forEach(p => { 
            p.hand = room.deck.splice(0, 7); 
            p.cardCount = 7;
            p.hasUno = false;
        });

        // İlk kart
        let first;
        do {
            first = room.deck.pop();
            const side = first.sides[room.currentSide];
            if (['wild4', 'wild_draw_color', 'wild_draw2'].includes(side.value)) {
                room.deck.unshift(first);
                room.deck = shuffle(room.deck);
                first = null;
            }
        } while (!first);
        
        room.discardPile.push(first);
        const activeFirst = first.sides[room.currentSide];
        
        if (activeFirst.color === 'black') {
            room.currentColor = null; 
            addLog(room, "Joker açıldı! İlk oyuncu rengi belirler.");
        } else {
            room.currentColor = activeFirst.color;
        }

        handleInitialCardEffect(room, activeFirst);
        startTurnTimer(room); // BURADA TIMER BAŞLIYOR VE DATA GÖNDERİLİYOR
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge || room.pendingDrawAction) return;

        resetTurnTimer(room); // Timer'ı durdur ama hemen broadcast etme, işlem bitince et

        ensureDeck(room);
        if(room.deck.length === 0) return;

        const drawnCard = room.deck.pop();
        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        const activeSide = drawnCard.sides[room.currentSide];
        const topCardObj = room.discardPile[room.discardPile.length - 1];
        const topActive = topCardObj.sides[room.currentSide];

        let isPlayable = false;
        if (activeSide.color === 'black') isPlayable = true;
        else if (room.currentColor && activeSide.color === room.currentColor) isPlayable = true;
        else if (activeSide.value === topActive.value) isPlayable = true;

        if (isPlayable) {
            room.pendingDrawAction = { playerId: player.id, cardId: drawnCard.id };
            socket.emit('drawDecisionRequired', { card: activeSide, message: "Oynamak ister misin?" });
            // Karar için süre ver
            startTurnTimer(room); 
        } else {
            addLog(room, "Oynanamaz. Pas.");
            advanceTurn(room);
            startTurnTimer(room);
        }
    });

    socket.on('handleDrawDecision', ({ action, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room.pendingDrawAction || room.pendingDrawAction.playerId !== socket.id) return;

        const player = room.players.find(p => p.id === socket.id);
        const cardIndex = player.hand.findIndex(c => c.id === room.pendingDrawAction.cardId);
        
        if (cardIndex === -1) return;

        if (action === 'play') {
            const card = player.hand[cardIndex];
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const activeCard = card.sides[room.currentSide];
            const oldColor = room.currentColor;
            room.currentColor = (activeCard.color === 'black') ? chosenColor : activeCard.color;
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);
            addLog(room, `${player.nickname} oynadı: ${formatCardName(activeCard)}`);
            
            room.pendingDrawAction = null;
            handleCardEffect(room, activeCard, player, oldColor);
        } else {
            addLog(room, `${player.nickname} pas geçti.`);
            room.pendingDrawAction = null;
            advanceTurn(room);
            startTurnTimer(room);
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge || room.pendingDrawAction) return;
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const activeCard = card.sides[room.currentSide];
        const topCardObj = room.discardPile[room.discardPile.length - 1];
        const topActive = topCardObj.sides[room.currentSide];
        
        let isValid = false;
        if (activeCard.color === 'black') isValid = true;
        else if (activeCard.color === room.currentColor) isValid = true;
        else if (activeCard.value === topActive.value) isValid = true;
        if (room.currentColor === null && activeCard.color !== 'black') isValid = true;

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            const oldColor = room.currentColor;
            room.currentColor = (activeCard.color === 'black') ? chosenColor : activeCard.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);
            addLog(room, `${player.nickname} attı: ${formatCardName(activeCard)}`);
            handleCardEffect(room, activeCard, player, oldColor);
        } else {
            socket.emit('error', 'Hatalı hamle!');
        }
    });

    socket.on('callUno', () => {
        const room = rooms.get(getPlayerRoomId(socket.id));
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            addLog(room, `📢 ${player.nickname} UNO Dedi!`);
            io.to(room.id).emit('playSound', 'uno');
            broadcastGameState(room.id);
        }
    });

    socket.on('catchUnoFailure', () => {
        const room = rooms.get(getPlayerRoomId(socket.id));
        if(!room) return;
        let caught = false;
        room.players.forEach(p => {
            if (p.hand.length === 1 && !room.unoCallers.has(p.id)) {
                addLog(room, `🚨 YAKALANDI! ${p.nickname} UNO demedi! (+2)`);
                drawCards(room, p, 2);
                caught = true;
            }
        });
        if (caught) broadcastGameState(room.id);
        else socket.emit('error', 'Yakalanacak kimse yok!');
    });

    socket.on('challengeDecision', ({ decision }) => {
        const room = rooms.get(getPlayerRoomId(socket.id));
        if(!room || !room.pendingChallenge) return;
        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if (socket.id !== victimId) return;

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (decision === 'accept') {
            addLog(room, `${victim.nickname} +4'ü yedi.`);
            drawCards(room, victim, 4);
            advanceTurn(room);
        } else {
            const hasColor = attacker.hand.some(c => c.sides[room.currentSide].color === oldColor && c.sides[room.currentSide].color !== 'black');
            if (hasColor) {
                addLog(room, `⚖️ BLÖF! ${attacker.nickname} ceza yedi (4 kart).`);
                drawCards(room, attacker, 4);
                advanceTurn(room);
            } else {
                addLog(room, `⚖️ TEMİZ! ${victim.nickname} ceza yedi (6 kart).`);
                drawCards(room, victim, 6);
                advanceTurn(room);
            }
        }
        room.pendingChallenge = null;
        startTurnTimer(room);
    });

    socket.on('chatMessage', ({ message, targetId }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const sender = room.players.find(p => p.id === socket.id);
        
        const chatData = { sender: sender.nickname, avatar: sender.avatar, msg: message, type: 'public', time: '' };
        if (targetId === 'all') {
            io.to(roomId).emit('chatBroadcast', chatData);
        } else {
            const tSock = io.sockets.sockets.get(targetId);
            if(tSock) {
                chatData.type = 'private';
                socket.emit('chatBroadcast', { ...chatData, isMe: true, to: tSock.data.nickname });
                tSock.emit('chatBroadcast', { ...chatData, isMe: false });
            }
        }
    });

    socket.on('returnToLobby', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(!roomId) return;
        const room = rooms.get(roomId);
        room.gameState = 'LOBBY';
        room.players.forEach(p => { p.hand = []; p.cardCount = 0; p.hasUno = false; });
        room.deck = []; room.discardPile = [];
        room.turnDeadline = 0;
        resetTurnTimer(room);
        io.to(roomId).emit('gameReset', { roomId });
        broadcastGameState(roomId);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) {
                resetTurnTimer(room);
                rooms.delete(roomId);
            } else {
                if(room.hostId === socket.id) room.hostId = room.players[0].id;
                broadcastGameState(roomId);
            }
        }
    });
});

// --- OYUN MANTIĞI ---

function handleInitialCardEffect(room, card) {
    if (card.value === 'skip') { addLog(room, "Engel!"); advanceTurn(room); } 
    else if (card.value === 'reverse') {
        room.direction *= -1; addLog(room, "Yön Değişti!");
        if (room.players.length === 2) advanceTurn(room);
        else room.turnIndex = room.players.length - 1;
    } else if (card.value.startsWith('draw')) {
        const count = parseInt(card.value.replace('draw', ''));
        drawCards(room, room.players[room.turnIndex], count);
        advanceTurn(room);
    } else if (card.value === 'skip_everyone') {
        addLog(room, "Herkes Atlandı!");
    }
}

function handleCardEffect(room, card, player, oldColor) {
    let skipNext = false;
    let nextPlayer = getNextPlayer(room);

    if (card.value === 'flip') {
        room.currentSide = (room.currentSide === 'light') ? 'dark' : 'light';
        addLog(room, `🌀 DÜNYA DÖNDÜ: ${room.currentSide.toUpperCase()}`);
        io.to(room.id).emit('playSound', 'turn');
        const top = room.discardPile[room.discardPile.length - 1];
        if (top.sides[room.currentSide].color !== 'black') room.currentColor = top.sides[room.currentSide].color;
    }

    if (card.value === 'skip') { skipNext = true; addLog(room, "Sıra atladı!"); }
    else if (card.value === 'reverse') {
        room.direction *= -1; addLog(room, "Yön değişti!");
        if (room.players.length === 2) skipNext = true;
    }
    else if (card.value === 'draw2') { drawCards(room, nextPlayer, 2); addLog(room, "+2!"); skipNext = true; }
    else if (card.value === 'draw1') { drawCards(room, nextPlayer, 1); addLog(room, "+1!"); skipNext = true; }
    else if (card.value === 'draw5') { drawCards(room, nextPlayer, 5); addLog(room, "+5!"); skipNext = true; }
    else if (card.value === 'wild4') {
        room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor };
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; 
    }
    else if (card.value === 'wild_draw2') { drawCards(room, nextPlayer, 2); addLog(room, "Joker +2!"); skipNext = true; }
    else if (card.value === 'skip_everyone') {
        addLog(room, "⛔ Herkes Atlandı, sıra yine sende.");
        if (player.hand.length === 0) { finishGame(room, player); return; }
        startTurnTimer(room); // Reset timer for same player
        broadcastGameState(room.id); // Önemli: broadcast state
        return;
    }
    else if (card.value === 'wild_draw_color') {
        addLog(room, `🎨 ${nextPlayer.nickname} renk bulana kadar çekiyor...`);
        let count = 0;
        let found = false;
        while(!found && count < 20) {
            ensureDeck(room);
            if(room.deck.length === 0) break;
            const c = room.deck.pop();
            nextPlayer.hand.push(c);
            count++;
            if (c.sides[room.currentSide].color === room.currentColor) found = true;
        }
        addLog(room, `${count} kart çekti.`);
        skipNext = true;
    }

    if (player.hand.length === 0) { finishGame(room, player); return; }

    advanceTurn(room);
    if (skipNext) advanceTurn(room);
    startTurnTimer(room); // Timer'ı yeni oyuncu için başlat
}

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    
    // Server-side deadline (Şimdiki zaman + 60sn)
    const duration = 60000;
    room.turnDeadline = Date.now() + duration;

    room.timer = setTimeout(() => {
        if(!rooms.has(room.id)) return;
        const cur = room.players[room.turnIndex];
        if (!cur) return;
        
        if (room.pendingDrawAction) {
            addLog(room, `⏳ ${cur.nickname} pas geçti (zaman aşımı).`);
            room.pendingDrawAction = null;
            advanceTurn(room);
        } else {
            drawCards(room, cur, 1);
            addLog(room, `⏳ ${cur.nickname} süre doldu, kart çekti.`);
            advanceTurn(room);
        }
        startTurnTimer(room); // Recursive call for next player
    }, duration);

    // Timer başladıktan sonra hemen state gönder ki client senkronize olsun
    broadcastGameState(room.id);
}

function resetTurnTimer(room) { 
    if(room.timer) clearTimeout(room.timer); 
    // Deadline'ı sıfırlamıyoruz ki broadcast sırasında "süre durdu" gibi görünmesin, 
    // ama mantıken timer durdu.
}

function finishGame(room, winner) {
    resetTurnTimer(room);
    room.turnDeadline = 0;
    let score = 0;
    room.players.forEach(p => { if (p.id !== winner.id) p.hand.forEach(c => score += c.sides[room.currentSide].score); });
    winner.totalScore = (winner.totalScore || 0) + score;
    const sorted = [...room.players].sort((a,b)=>b.totalScore-a.totalScore);
    io.to(room.id).emit('gameOver', { winner: winner.nickname, score, players: sorted });
    broadcastGameState(room.id);
}

function ensureDeck(room) {
    if(room.deck.length === 0 && room.discardPile.length > 1) {
        const top = room.discardPile.pop();
        room.deck = shuffle(room.discardPile);
        room.discardPile = [top];
        addLog(room, "Deste karıştırıldı.");
    }
}
function drawCards(room, p, n) { for(let i=0;i<n;i++) { ensureDeck(room); if(room.deck.length>0) p.hand.push(room.deck.pop()); } }
function advanceTurn(room) { room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length; }
function getNextPlayer(room) { return room.players[(room.turnIndex + room.direction + room.players.length) % room.players.length]; }
function getPlayerRoomId(sid) { for (const [id, r] of rooms) { if (r.players.find(p=>p.id===sid)) return id; } return null; }
function joinRoomHandler(socket, rid, name, av) {
    const r = rooms.get(rid);
    if (!r) return socket.emit('error', 'Oda yok.');
    socket.join(rid);
    if(!r.players.find(p=>p.id===socket.id)) r.players.push({ id: socket.id, nickname: name, avatar: av, hand: [], score: 0 });
    broadcastGameState(rid);
}
function addLog(room, msg) {
    io.to(room.id).emit('chatBroadcast', { sender: 'SİSTEM', msg, type: 'log', time: '' });
    room.logs.push(msg); if(room.logs.length>6) room.logs.shift();
}
function formatCardName(c) { return (c.color==='black') ? c.value.toUpperCase() : `${c.color.toUpperCase()} ${c.value}`; }

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;
    room.players.forEach(p => {
        const s = io.sockets.sockets.get(p.id);
        if (s) s.emit('roomUpdate', {
            roomId: room.id,
            isHost: p.id === room.hostId,
            gameState: room.gameState,
            gameMode: room.gameMode,
            currentSide: room.currentSide,
            players: room.players.map(pl => ({ id: pl.id, nickname: pl.nickname, avatar: pl.avatar, cardCount: pl.hand.length, hasUno: room.unoCallers.has(pl.id), totalScore: pl.totalScore })),
            myHand: p.hand,
            topCard: room.discardPile[room.discardPile.length-1],
            currentColor: room.currentColor,
            logs: room.logs,
            turnOwner: room.players[room.turnIndex].nickname,
            isMyTurn: room.players[room.turnIndex].id === p.id,
            turnDeadline: room.turnDeadline, // Kritik: Timestamp gönderiyoruz
            pendingChallenge: !!room.pendingChallenge,
            pendingDrawAction: room.pendingDrawAction && room.pendingDrawAction.playerId === p.id
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server Aktif Port:', PORT));
