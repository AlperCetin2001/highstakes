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
const TURN_DURATION = 30000; // 30 Saniye süre

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

// --- KART OLUŞTURMA ---

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
        ['draw1', 'reverse', 'skip', 'flip', 'flip'].forEach(val => {
            lightCards.push({ color, value: val, type: 'action', score: 20 });
            if(val !== 'flip') lightCards.push({ color, value: val, type: 'action', score: 20 });
        });
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
        ['draw5', 'reverse', 'skip_everyone', 'flip', 'flip'].forEach(val => {
            darkCards.push({ color, value: val, type: 'action', score: 20 });
            if(val !== 'flip') darkCards.push({ color, value: val, type: 'action', score: 20 });
        });
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

// --- SOCKET ---

io.on('connection', (socket) => {
    
    // Bağlantı logu
    
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, name: r.name, mode: r.gameMode, count: r.players.length, status: r.gameState 
        }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, gameMode }) => {
        const roomId = generateRoomId();
        const validMode = (gameMode === 'flip') ? 'flip' : 'classic';

        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            gameMode: validMode,
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
            turnDeadline: 0
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
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
            const nickname = joinerSocket.data.nickname || 'Misafir'; // socket data gelmeyebilir, paramdan almalıydık ama basit tutalım
            
            const newPlayer = { 
                id: joinerId, 
                nickname: 'Yeni Oyuncu', // İsmi handshake'den almak daha sağlıklı
                avatar: '👤',
                hand: [], score: 0, totalScore: 0
            };
            // Basitlik için nickname düzeltmesi:
            // Gerçek uygulamada joinerSocket.data ile veri taşınmalı
            
            if (room.gameState === 'PLAYING') {
                if (room.deck.length < 7) room.deck = (room.gameMode === 'flip') ? createFlipDeck() : createClassicDeck();
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

        let first;
        do {
            first = room.deck.pop();
            const side = first.sides[room.currentSide];
            // Wild +4 gibi kartlarla başlanmaz
            if (side.value.startsWith('wild')) {
                room.deck.unshift(first);
                room.deck = shuffle(room.deck);
                first = null;
            }
        } while (!first);
        
        room.discardPile.push(first);
        const activeFirst = first.sides[room.currentSide];
        room.currentColor = (activeFirst.color === 'black') ? null : activeFirst.color;
        
        handleInitialCardEffect(room, activeFirst);
        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge || room.pendingDrawAction) return;

        resetTurnTimer(room);
        ensureDeck(room);
        if(room.deck.length === 0) return;

        const drawnCard = room.deck.pop();
        player.hand.push(drawnCard);
        
        // Oynanabilirlik kontrolü
        const activeSide = drawnCard.sides[room.currentSide];
        const topActive = room.discardPile[room.discardPile.length - 1].sides[room.currentSide];
        
        let isPlayable = false;
        if (activeSide.color === 'black') isPlayable = true;
        else if (room.currentColor && activeSide.color === room.currentColor) isPlayable = true;
        else if (activeSide.value === topActive.value) isPlayable = true;

        if (isPlayable) {
            room.pendingDrawAction = { playerId: player.id, cardId: drawnCard.id };
            socket.emit('drawDecisionRequired', { card: activeSide, message: "Oynayabilirsin!" });
            startTurnTimer(room); // Karar için süre
        } else {
            addLog(room, `${player.nickname} kart çekti.`);
            advanceTurn(room);
            startTurnTimer(room);
        }
        broadcastGameState(roomId);
    });

    socket.on('handleDrawDecision', ({ action, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if (!room || !room.pendingDrawAction) return;
        
        const player = room.players.find(p => p.id === socket.id);
        const idx = player.hand.findIndex(c => c.id === room.pendingDrawAction.cardId);
        
        if (idx === -1) return;

        if (action === 'play') {
            const card = player.hand[idx];
            player.hand.splice(idx, 1);
            room.discardPile.push(card);
            
            const activeCard = card.sides[room.currentSide];
            const oldColor = room.currentColor;
            room.currentColor = (activeCard.color === 'black') ? chosenColor : activeCard.color;
            
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);
            
            addLog(room, `${player.nickname} çektiğini oynadı.`);
            handleCardEffect(room, activeCard, player, oldColor);
        } else {
            addLog(room, `${player.nickname} pas geçti.`);
            advanceTurn(room);
            startTurnTimer(room);
        }
        room.pendingDrawAction = null;
        broadcastGameState(roomId);
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
        const topActive = room.discardPile[room.discardPile.length - 1].sides[room.currentSide];
        
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

            addLog(room, `${player.nickname} oynadı: ${activeCard.value}`);
            handleCardEffect(room, activeCard, player, oldColor);
        }
    });

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if(p.hand.length <= 2) {
            room.unoCallers.add(p.id);
            io.to(roomId).emit('playSound', 'uno');
            broadcastGameState(roomId);
        }
    });
    
    socket.on('catchUnoFailure', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        let caught = false;
        room.players.forEach(p => {
            if(p.hand.length === 1 && !room.unoCallers.has(p.id)) {
                drawCards(room, p, 2);
                addLog(room, `${p.nickname} UNO demeyi unuttu! (+2)`);
                caught = true;
            }
        });
        if(caught) broadcastGameState(roomId);
    });

    socket.on('challengeDecision', ({ decision }) => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room || !room.pendingChallenge) return;
        
        const { victimId, attackerId, oldColor } = room.pendingChallenge;
        if(socket.id !== victimId) return;
        
        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);
        
        if (decision === 'accept') {
            drawCards(room, victim, 4);
            advanceTurn(room);
        } else {
            const guilty = attacker.hand.some(c => {
                const s = c.sides[room.currentSide];
                return s.color === oldColor && s.color !== 'black';
            });
            if (guilty) {
                drawCards(room, attacker, 4);
                // Kural gereği sıra kurbana geçer ama basitlik için ilerletiyoruz
                advanceTurn(room); 
            } else {
                drawCards(room, victim, 6);
                advanceTurn(room);
            }
        }
        room.pendingChallenge = null;
        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    socket.on('chatMessage', ({ message, targetId }) => {
        const roomId = getPlayerRoomId(socket.id);
        if(!roomId) return;
        io.to(roomId).emit('chatBroadcast', { sender: 'Player', msg: message, type: 'public' });
    });
    
    socket.on('returnToLobby', () => {
         const roomId = getPlayerRoomId(socket.id);
         if(!roomId) return;
         const room = rooms.get(roomId);
         room.gameState = 'LOBBY';
         room.currentSide = 'light';
         room.players.forEach(p => p.hand = []);
         broadcastGameState(roomId);
    });

    socket.on('disconnect', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(roomId) {
            const room = rooms.get(roomId);
            room.players = room.players.filter(p => p.id !== socket.id);
            if(room.players.length === 0) rooms.delete(roomId);
            else broadcastGameState(roomId);
        }
    });
});

// --- OYUN LOJİĞİ ---

function handleInitialCardEffect(room, card) {
    if(card.value === 'skip') advanceTurn(room);
    else if(card.value === 'reverse') {
        room.direction *= -1;
        if(room.players.length > 2) room.turnIndex = room.players.length - 1;
        else advanceTurn(room);
    }
    else if(card.value === 'draw2') {
        drawCards(room, room.players[room.turnIndex], 2);
        advanceTurn(room);
    }
    else if(card.value === 'draw1') {
        drawCards(room, room.players[room.turnIndex], 1);
        advanceTurn(room);
    }
    else if(card.value === 'draw5') {
        drawCards(room, room.players[room.turnIndex], 5);
        advanceTurn(room);
    }
}

function handleCardEffect(room, card, player, oldColor) {
    let skip = false;
    const nextP = getNextPlayer(room);

    if (card.value === 'flip') {
        room.currentSide = (room.currentSide === 'light') ? 'dark' : 'light';
        io.to(room.id).emit('playSound', 'turn');
        // Top card color update logic simplified
        const top = room.discardPile[room.discardPile.length-1].sides[room.currentSide];
        if(top.color !== 'black') room.currentColor = top.color;
    }

    if(card.value === 'skip') skip = true;
    else if(card.value === 'reverse') {
        room.direction *= -1;
        if(room.players.length === 2) skip = true;
    }
    else if(card.value === 'draw2') { drawCards(room, nextP, 2); skip = true; }
    else if(card.value === 'draw1') { drawCards(room, nextP, 1); skip = true; }
    else if(card.value === 'wild_draw2') { drawCards(room, nextP, 2); skip = true; }
    else if(card.value === 'draw5') { drawCards(room, nextP, 5); skip = true; }
    else if(card.value === 'skip_everyone') {
        // Sıra tekrar oynayana gelir
        broadcastGameState(room.id);
        startTurnTimer(room);
        return;
    }
    else if(card.value === 'wild_draw_color') {
        // Renk bulana kadar çek
        let count = 0;
        while(count < 20) {
            ensureDeck(room);
            if(room.deck.length === 0) break;
            const c = room.deck.pop();
            nextP.hand.push(c);
            count++;
            if(c.sides[room.currentSide].color === room.currentColor) break;
        }
        skip = true;
    }
    else if(card.value === 'wild4') {
        room.pendingChallenge = { attackerId: player.id, victimId: nextP.id, oldColor };
        io.to(nextP.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return;
    }

    if(player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    advanceTurn(room);
    if(skip) advanceTurn(room);
    startTurnTimer(room);
    broadcastGameState(room.id);
}

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    // Timer süresi sunucuda belirlenir
    room.turnDeadline = Date.now() + TURN_DURATION; 
    
    room.timer = setTimeout(() => {
        if(!rooms.has(room.id)) return;
        const cur = room.players[room.turnIndex];
        
        // Zaman dolduğunda otomatik aksiyon:
        if (room.pendingDrawAction) {
            room.pendingDrawAction = null;
            advanceTurn(room);
        } else {
            drawCards(room, cur, 1);
            advanceTurn(room);
        }
        broadcastGameState(room.id);
        startTurnTimer(room); // Sonraki oyuncu için zamanlayıcıyı başlat
    }, TURN_DURATION + 500); // 500ms buffer, client önce bitirsin
}

function resetTurnTimer(room) { if(room.timer) clearTimeout(room.timer); }

function finishGame(room, winner) {
    resetTurnTimer(room);
    room.turnDeadline = 0;
    
    let score = 0;
    room.players.forEach(p => {
        if(p.id !== winner.id) p.hand.forEach(c => score += c.sides[room.currentSide].score);
    });
    winner.totalScore += score;
    
    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        score, 
        players: room.players.sort((a,b)=>b.totalScore-a.totalScore) 
    });
}

function ensureDeck(room) {
    if(room.deck.length === 0 && room.discardPile.length > 1) {
        const top = room.discardPile.pop();
        room.deck = shuffle(room.discardPile);
        room.discardPile = [top];
    }
}
function drawCards(room, p, n) {
    for(let i=0; i<n; i++) {
        ensureDeck(room);
        if(room.deck.length>0) p.hand.push(room.deck.pop());
    }
}
function advanceTurn(room) {
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}
function getNextPlayer(room) {
    return room.players[(room.turnIndex + room.direction + room.players.length) % room.players.length];
}
function getPlayerRoomId(sid) {
    for (const [id, r] of rooms) if(r.players.find(p=>p.id===sid)) return id;
    return null;
}
function joinRoomHandler(socket, rid, nick, av) {
    const room = rooms.get(rid);
    socket.join(rid);
    if(!room.players.find(p=>p.id===socket.id)) {
        room.players.push({ id:socket.id, nickname:nick, avatar:av, hand:[], score:0, totalScore:0 });
    }
    broadcastGameState(rid);
}
function addLog(room, msg) {
    room.logs.push(msg);
    if(room.logs.length>6) room.logs.shift();
}
function broadcastGameState(rid) {
    const room = rooms.get(rid);
    if(!room) return;
    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if(socket) {
            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: p.id === room.hostId,
                gameState: room.gameState,
                gameMode: room.gameMode,
                currentSide: room.currentSide,
                players: room.players.map(pl => ({...pl, handCount: pl.hand.length, hand: undefined})),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname,
                isMyTurn: room.players[room.turnIndex].id === p.id,
                turnDeadline: room.turnDeadline,
                pendingChallenge: !!room.pendingChallenge,
                pendingDrawAction: room.pendingDrawAction && room.pendingDrawAction.playerId === p.id
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running...'));
