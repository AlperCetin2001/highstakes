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

function createClassicDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];

    colors.forEach(color => {
        deck.push({ 
            id: Math.random().toString(36),
            sides: {
                light: { color, value: '0', type: 'number', score: 0 }
            }
        });
        
        for (let i = 1; i <= 9; i++) {
            deck.push({ 
                id: Math.random().toString(36),
                sides: {
                    light: { color, value: i.toString(), type: 'number', score: i }
                }
            });
            deck.push({ 
                id: Math.random().toString(36),
                sides: {
                    light: { color, value: i.toString(), type: 'number', score: i }
                }
            });
        }
        
        ['skip', 'reverse', 'draw2'].forEach(val => {
            deck.push({ 
                id: Math.random().toString(36),
                sides: {
                    light: { color, value: val, type: 'action', score: 20 }
                }
            });
            deck.push({ 
                id: Math.random().toString(36),
                sides: {
                    light: { color, value: val, type: 'action', score: 20 }
                }
            });
        });
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ 
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'wild', type: 'wild', score: 50 }
            }
        });
        deck.push({ 
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'wild4', type: 'wild', score: 50 }
            }
        });
    }

    return shuffle(deck);
}

function createFlipDeck() {
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    const darkColors = ['pink', 'teal', 'orange', 'purple'];
    const deck = [];

    // Light side numbers (0-9)
    lightColors.forEach(color => {
        // Number 0 (one per color)
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value: '0', type: 'number', score: 0 },
                dark: { color: darkColors[lightColors.indexOf(color)], value: '0', type: 'number', score: 0 }
            }
        });
        
        // Numbers 1-9 (two each)
        for (let i = 1; i <= 9; i++) {
            deck.push({
                id: Math.random().toString(36),
                sides: {
                    light: { color, value: i.toString(), type: 'number', score: i },
                    dark: { color: darkColors[lightColors.indexOf(color)], value: i.toString(), type: 'number', score: i }
                }
            });
            deck.push({
                id: Math.random().toString(36),
                sides: {
                    light: { color, value: i.toString(), type: 'number', score: i },
                    dark: { color: darkColors[lightColors.indexOf(color)], value: i.toString(), type: 'number', score: i }
                }
            });
        }
    });

    // Light side action cards (Skip, Reverse, Draw One)
    lightColors.forEach(color => {
        const darkColor = darkColors[lightColors.indexOf(color)];
        
        // Skip (2 each)
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value: 'skip', type: 'action', score: 20 },
                dark: { color: darkColor, value: 'skip', type: 'action', score: 20 }
            }
        });
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value: 'skip', type: 'action', score: 20 },
                dark: { color: darkColor, value: 'skip', type: 'action', score: 20 }
            }
        });
        
        // Reverse (2 each)
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value: 'reverse', type: 'action', score: 20 },
                dark: { color: darkColor, value: 'reverse', type: 'action', score: 20 }
            }
        });
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value: 'reverse', type: 'action', score: 20 },
                dark: { color: darkColor, value: 'reverse', type: 'action', score: 20 }
            }
        });
        
        // Draw One (replaces Draw Two in UNO Flip) - 2 each
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value: 'draw1', type: 'action', score: 20 },
                dark: { color: darkColor, value: 'draw5', type: 'action', score: 20 }
            }
        });
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value: 'draw1', type: 'action', score: 20 },
                dark: { color: darkColor, value: 'draw5', type: 'action', score: 20 }
            }
        });
    });

    // Dark side special cards (Skip Everyone, Wild Draw Color)
    darkColors.forEach(color => {
        // Skip Everyone (1 each)
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color: lightColors[darkColors.indexOf(color)], value: 'skip', type: 'action', score: 20 },
                dark: { color, value: 'skipall', type: 'action', score: 40 }
            }
        });
    });

    // Wild cards
    for (let i = 0; i < 4; i++) {
        // Wild (Light) / Wild (Dark)
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'wild', type: 'wild', score: 50 },
                dark: { color: 'dark-black', value: 'wild', type: 'wild', score: 50 }
            }
        });
        
        // Wild Draw Four (Light) / Wild Draw Color (Dark)
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'wild4', type: 'wild', score: 50 },
                dark: { color: 'dark-black', value: 'wilddrawcolor', type: 'wild', score: 50 }
            }
        });
        
        // FLIP cards (2 total in deck)
        if (i < 2) {
            deck.push({
                id: Math.random().toString(36),
                sides: {
                    light: { color: 'black', value: 'flip', type: 'action', score: 20 },
                    dark: { color: 'dark-black', value: 'flip', type: 'action', score: 20 }
                }
            });
        }
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
    
    const queryName = socket.handshake.query.nickname;
    const queryAvatar = socket.handshake.query.avatar;
    if(queryName) {
        socket.data.nickname = queryName;
        socket.data.avatar = queryAvatar || '👤';
    }

    socket.on('getRooms', () => {
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, 
            name: r.name, 
            count: r.players.length, 
            status: r.gameState,
            gameMode: r.gameMode
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
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            gameMode: gameMode || 'classic',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            currentSide: 'light', // 'light' or 'dark'
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            pendingDrawAction: null,
            timer: null,
            turnDeadline: 0,
            pendingWildDrawColor: null // For Wild Draw Color card
        };
        rooms.set(roomId, room);
        joinRoomHandler(socket, roomId, nickname, avatar);
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;
        
        const room = rooms.get(roomId);
        if (!room) return socket.emit('error', 'Oda bulunamadı.');

        const existingPlayer = room.players.find(p => p.nickname === nickname);
        if (existingPlayer && room.gameState === 'PLAYING') {
             existingPlayer.id = socket.id;
             socket.join(roomId);
             broadcastGameState(roomId);
             return;
        }

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
            const nickname = joinerSocket.data.nickname || 'Misafir';
            const avatar = joinerSocket.data.avatar || '👤';

            const newPlayer = { 
                id: joinerId, 
                nickname: nickname,
                avatar: avatar,
                hand: [],
                score: 0,
                totalScore: 0
            };
            
            if (room.deck.length < 7) { 
                room.deck = room.gameMode === 'flip' ? createFlipDeck() : createClassicDeck();
            }
            newPlayer.hand = room.deck.splice(0, 7);
            
            room.players.push(newPlayer);
            addLog(room, `Yeni oyuncu katıldı: ${nickname}`);
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
        room.deck = room.gameMode === 'flip' ? createFlipDeck() : createClassicDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0;
        room.currentSide = 'light';
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        room.pendingDrawAction = null;
        room.pendingWildDrawColor = null;
        
        room.players.forEach(p => { 
            p.hand = room.deck.splice(0, 7); 
            p.cardCount = 7;
            p.hasUno = false;
        });

        // --- İLK KART ---
        let first;
        do {
            first = room.deck.pop();
            // Eğer Wild Draw 4 veya Wild Draw Color çıkarsa, desteye geri koy
            const firstActive = getActiveSide(first, room.currentSide);
            if (firstActive.value === 'wild4' || firstActive.value === 'wilddrawcolor') {
                room.deck.push(first);
                room.deck = shuffle(room.deck);
            }
        } while (firstActive.value === 'wild4' || firstActive.value === 'wilddrawcolor');
        
        room.discardPile.push(first);
        
        const firstActive = getActiveSide(first, room.currentSide);
        if (firstActive.color === 'black' || firstActive.color === 'dark-black') {
            room.currentColor = null;
            addLog(room, "Joker açıldı! İlk oyuncu rengi belirliyor.");
        } else {
            room.currentColor = firstActive.color;
        }

        // İlk kart etkileri
        if (firstActive.value === 'skip') {
            addLog(room, "Başlangıçta Engel! İlk oyuncu atlandı.");
            advanceTurn(room);
        } else if (firstActive.value === 'reverse') {
            room.direction *= -1;
            addLog(room, "Başlangıçta Yön Değişti!");
            if (room.players.length === 2) {
                advanceTurn(room); 
            } else {
                room.turnIndex = room.players.length - 1;
            }
        } else if (firstActive.value === 'draw2' || firstActive.value === 'draw1') {
            const firstPlayer = room.players[room.turnIndex];
            const drawCount = firstActive.value === 'draw2' ? 2 : 1;
            addLog(room, `Başlangıçta +${drawCount}! ${firstPlayer.nickname} ${drawCount} kart çekiyor ve sıra geçiyor.`);
            drawCards(room, firstPlayer, drawCount);
            advanceTurn(room);
        } else if (firstActive.value === 'draw5') {
            const firstPlayer = room.players[room.turnIndex];
            addLog(room, `Başlangıçta +5! ${firstPlayer.nickname} 5 kart çekiyor ve sıra geçiyor.`);
            drawCards(room, firstPlayer, 5);
            advanceTurn(room);
        }
        
        // Tüm oyunculara side değişikliğini bildir
        io.to(room.id).emit('sideChanged', { newSide: room.currentSide, playerName: null });
        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    // --- KART ÇEKME ---
    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;
        if (room.pendingDrawAction) return;
        if (room.pendingWildDrawColor) return;

        resetTurnTimer(room);
        
        // Wild Draw Color durumunda
        if (room.pendingWildDrawColor && room.pendingWildDrawColor.victimId === socket.id) {
            let drawnCard = null;
            if(room.deck.length === 0 && room.discardPile.length > 1) {
                const top = room.discardPile.pop();
                room.deck = shuffle(room.discardPile);
                room.discardPile = [top];
            }
            if(room.deck.length > 0) drawnCard = room.deck.pop();
            
            if (drawnCard) {
                player.hand.push(drawnCard);
                const activeCard = getActiveSide(drawnCard, room.currentSide);
                
                // Çekilen kart istenen renkte mi?
                if (activeCard.color === room.pendingWildDrawColor.chosenColor) {
                    // Doğru renk bulundu, ceza sona erdi
                    addLog(room, `${player.nickname} doğru rengi buldu! ${room.pendingWildDrawColor.drawCount} kart çekti.`);
                    room.pendingWildDrawColor = null;
                    advanceTurn(room);
                } else {
                    // Yanlış renk, çekmeye devam
                    addLog(room, `${player.nickname} ${activeCard.color} renginde kart çekti. Doğru renk ${room.pendingWildDrawColor.chosenColor}. Çekmeye devam...`);
                    room.pendingWildDrawColor.drawCount++;
                    
                    // Yeni kart çekmesi için tekrar çağır
                    setTimeout(() => {
                        socket.emit('notification', { msg: `Doğru rengi bulana kadar çekmeye devam et! (${room.pendingWildDrawColor.drawCount}. kart)` });
                        broadcastGameState(roomId);
                    }, 1000);
                }
            }
            broadcastGameState(roomId);
            return;
        }
        
        // Normal kart çekme
        let drawnCard = null;
        if(room.deck.length === 0 && room.discardPile.length > 1) {
             const top = room.discardPile.pop();
             room.deck = shuffle(room.discardPile);
             room.discardPile = [top];
        }
        if(room.deck.length > 0) drawnCard = room.deck.pop();
        else return;

        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        const top = room.discardPile[room.discardPile.length - 1];
        const topActive = getActiveSide(top, room.currentSide);
        const drawnActive = getActiveSide(drawnCard, room.currentSide);
        
        let isPlayable = false;
        if (drawnActive.color === 'black' || drawnActive.color === 'dark-black') isPlayable = true;
        else if (room.currentColor && drawnActive.color === room.currentColor) isPlayable = true;
        else if (drawnActive.value === topActive.value) isPlayable = true;

        if (isPlayable) {
            room.pendingDrawAction = { playerId: player.id, cardId: drawnCard.id };
            socket.emit('drawDecisionRequired', { 
                card: drawnCard, 
                message: "Oynanabilir bir kart çektin! Oynamak ister misin?" 
            });
            broadcastGameState(roomId);
            startTurnTimer(room);
        } else {
            addLog(room, "Çekilen kart oynanamaz. Sıra geçiyor.");
            advanceTurn(room);
            broadcastGameState(roomId);
            startTurnTimer(room);
        }
    });

    // --- ÇEKİLEN KARTI OYNAMA/PAS GEÇME ---
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
            
            const activeCard = getActiveSide(card, room.currentSide);
            const oldColor = room.currentColor;
            room.currentColor = (activeCard.color === 'black' || activeCard.color === 'dark-black') ? chosenColor : activeCard.color;
            
            if (player.hand.length === 1) {
                // Uno demediyse "unsafe" durum
            }
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} çektiği kartı oynadı: ${formatCardName(activeCard)}`);
            room.pendingDrawAction = null;
            handleCardEffect(room, card, player, oldColor);

        } else {
            addLog(room, `${player.nickname} pas geçti.`);
            room.pendingDrawAction = null;
            advanceTurn(room);
            broadcastGameState(roomId);
            startTurnTimer(room);
        }
    });

    socket.on('chatMessage', ({ message, targetId }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const sender = room.players.find(p => p.id === socket.id);
        if(!sender) return;

        const chatData = {
            sender: sender.nickname,
            avatar: sender.avatar,
            msg: message,
            type: 'public',
            time: new Date().toLocaleTimeString('tr-TR', {hour: '2-digit', minute:'2-digit'})
        };

        if (targetId === 'all') {
            chatData.type = 'public';
            io.to(roomId).emit('chatBroadcast', chatData);
        } else {
            const targetSocket = io.sockets.sockets.get(targetId);
            if(targetSocket) {
                chatData.type = 'private';
                chatData.to = targetSocket.data.nickname;
                socket.emit('chatBroadcast', { ...chatData, isMe: true });
                targetSocket.emit('chatBroadcast', { ...chatData, isMe: false });
            }
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingChallenge) return;
        if (room.pendingDrawAction) return;
        if (room.pendingWildDrawColor) return;
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const activeCard = getActiveSide(card, room.currentSide);
        const top = room.discardPile[room.discardPile.length - 1];
        const topActive = getActiveSide(top, room.currentSide);
        
        let isValid = false;
        if (activeCard.color === 'black' || activeCard.color === 'dark-black') isValid = true;
        else if (activeCard.color === room.currentColor) isValid = true;
        else if (activeCard.value === topActive.value) isValid = true;
        if (room.currentColor === null && activeCard.color !== 'black' && activeCard.color !== 'dark-black') isValid = true;

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (activeCard.color === 'black' || activeCard.color === 'dark-black') ? chosenColor : activeCard.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(activeCard)}`);
            handleCardEffect(room, card, player, oldColorForChallenge);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

    // --- UNO BİLDİRİMİ ---
    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        if (player.hand.length <= 2) {
            room.unoCallers.add(player.id);
            addLog(room, `📢 ${player.nickname} UNO Dedi!`);
            io.to(roomId).emit('playSound', 'uno');
            broadcastGameState(roomId);
        }
    });

    // --- UNO MEYDAN OKUMA ---
    socket.on('catchUnoFailure', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const challenger = room.players.find(p => p.id === socket.id);

        let caughtSomeone = false;
        room.players.forEach(p => {
            if (p.hand.length === 1 && !room.unoCallers.has(p.id)) {
                addLog(room, `🚨 YAKALANDI! ${p.nickname} UNO demeyi unuttu! (+2 Kart)`);
                drawCards(room, p, 2);
                caughtSomeone = true;
            }
        });

        if (caughtSomeone) {
            broadcastGameState(roomId);
        } else {
            socket.emit('error', 'Yakalanacak kimse yok!');
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
            advanceTurn(room); 
        } else {
            const hasColor = attacker.hand.some(c => {
                const activeCard = getActiveSide(c, room.currentSide);
                return activeCard.color === oldColor && activeCard.color !== 'black' && activeCard.color !== 'dark-black';
            });
            
            if (hasColor) {
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yapmıştı! (Ceza: 4 Kart)`);
                drawCards(room, attacker, 4);
                advanceTurn(room);
            } else {
                addLog(room, `⚖️ TEMİZ! ${attacker.nickname} dürüsttü. ${victim.nickname} 6 kart çekiyor!`);
                drawCards(room, victim, 6);
                advanceTurn(room);
            }
        }

        room.pendingChallenge = null;
        broadcastGameState(roomId);
        startTurnTimer(room);
    });

    socket.on('returnToLobby', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(!roomId) return;
        const room = rooms.get(roomId);
        
        room.gameState = 'LOBBY';
        room.players.forEach(p => {
            p.hand = [];
            p.cardCount = 0;
            p.hasUno = false;
        });
        room.deck = [];
        room.discardPile = [];
        room.pendingChallenge = null;
        room.pendingDrawAction = null;
        room.pendingWildDrawColor = null;
        room.logs = [];
        room.turnDeadline = 0;
        room.currentSide = 'light';
        
        io.to(roomId).emit('gameReset', { roomId });
        io.to(roomId).emit('sideChanged', { newSide: 'light', playerName: null });
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

function handleCardEffect(room, card, player, oldColorForChallenge) {
    const activeCard = getActiveSide(card, room.currentSide);
    let skipNext = false;

    if (activeCard.value === 'skip') { 
        skipNext = true; 
        addLog(room, "Sıra atladı!"); 
    } 
    else if (activeCard.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) { skipNext = true; } 
    }
    else if (activeCard.value === 'draw2') {
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`);
        skipNext = true;
    }
    else if (activeCard.value === 'draw1') {
        const next = getNextPlayer(room);
        drawCards(room, next, 1);
        addLog(room, `${next.nickname} +1 yedi!`);
        skipNext = true;
    }
    else if (activeCard.value === 'draw5') {
        const next = getNextPlayer(room);
        drawCards(room, next, 5);
        addLog(room, `${next.nickname} +5 yedi!`);
        skipNext = true;
    }
    else if (activeCard.value === 'skipall') {
        // Skip Everyone: Herkes atlanır, atan tekrar oynar
        addLog(room, `⏩ ${player.nickname} herkesi atladı! Tekrar oynayacak.`);
        // Sıra değişmez, aynı oyuncu tekrar oynar
        skipNext = false;
        // Turu atlamayacağız, sadece log ekleyip broadcast yapacağız
        broadcastGameState(room.id);
        startTurnTimer(room);
        return;
    }
    else if (activeCard.value === 'wild4') {
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
    else if (activeCard.value === 'wilddrawcolor') {
        // Wild Draw Color: Sonraki oyuncu seçilen rengi bulana kadar çeker
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        
        room.pendingWildDrawColor = {
            victimId: nextPlayer.id,
            chosenColor: room.currentColor,
            drawCount: 0
        };
        
        addLog(room, `🎨 ${player.nickname} ${room.currentColor} rengini seçti! ${nextPlayer.nickname} bu rengi bulana kadar çekecek.`);
        broadcastGameState(room.id);
        startTurnTimer(room);
        return;
    }
    else if (activeCard.value === 'flip') {
        // Flip kartı: Tarafları değiştir
        room.currentSide = room.currentSide === 'light' ? 'dark' : 'light';
        addLog(room, `🔄 ${player.nickname} oyunu ${room.currentSide === 'light' ? 'Aydınlık' : 'Karanlık'} tarafa çevirdi!`);
        
        // Tüm oyunculara side değişikliğini bildir
        io.to(room.id).emit('sideChanged', { newSide: room.currentSide, playerName: player.nickname });
        
        // Flip sonrası normal devam et
        if (player.hand.length === 0) {
            finishGame(room, player);
            return;
        }
        
        advanceTurn(room);
        broadcastGameState(room.id);
        startTurnTimer(room);
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

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    room.turnDeadline = Date.now() + 60000;
    
    room.timer = setTimeout(() => {
        if(!rooms.has(room.id)) return;
        
        const currentPlayer = room.players[room.turnIndex];
        if (!currentPlayer) {
            advanceTurn(room);
            broadcastGameState(room.id);
            return;
        }

        // Wild Draw Color durumunda süre dolduysa, ceza otomatik uygulansın
        if (room.pendingWildDrawColor && room.pendingWildDrawColor.victimId === currentPlayer.id) {
            addLog(room, `⏳ ${currentPlayer.nickname} süre doldu, ${room.pendingWildDrawColor.drawCount} kart çekti.`);
            room.pendingWildDrawColor = null;
            advanceTurn(room);
        }
        // Karar bekliyorsa
        else if (room.pendingDrawAction) {
            addLog(room, `⏳ ${currentPlayer.nickname} karar vermedi, pas geçildi.`);
            room.pendingDrawAction = null;
            advanceTurn(room);
        } else {
            // Normal süresi dolduysa kart çek ve pas geç
            drawCards(room, currentPlayer, 1);
            addLog(room, `⏳ ${currentPlayer.nickname} süre doldu, kart çekti.`);
            advanceTurn(room);
        }
        
        broadcastGameState(room.id);
        startTurnTimer(room);
    }, 60000);
}

function resetTurnTimer(room) { if(room.timer) clearTimeout(room.timer); }

function finishGame(room, winner) {
    if(room.timer) clearTimeout(room.timer);
    room.turnDeadline = 0;
    room.pendingWildDrawColor = null;
    
    let roundScore = 0;
    room.players.forEach(p => {
        if (p.id !== winner.id) {
            p.hand.forEach(c => {
                const activeCard = getActiveSide(c, room.currentSide);
                roundScore += activeCard.score;
            });
        }
    });

    if (!winner.totalScore) winner.totalScore = 0;
    winner.totalScore += roundScore;

    const winnerInList = room.players.find(p => p.id === winner.id);
    if(winnerInList) winnerInList.totalScore = winner.totalScore;
    
    const sortedPlayers = [...room.players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, 
        score: roundScore,
        players: sortedPlayers
    });
    
    broadcastGameState(room.id);
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    socket.join(roomId);
    
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        room.players.push({ 
            id: socket.id, 
            nickname: nickname, 
            avatar: avatar, 
            hand: [],
            score: 0,
            totalScore: 0
        });
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
            } else {
                room.deck = room.gameMode === 'flip' ? createFlipDeck() : createClassicDeck();
            }
        }
        if(room.deck.length > 0) {
            player.hand.push(room.deck.pop());
        }
    }
    player.cardCount = player.hand.length;
}

function advanceTurn(room) {
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function getNextPlayerIndex(room) {
    return (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function getNextPlayer(room) { 
    return room.players[getNextPlayerIndex(room)]; 
}

function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}

function addLog(room, msg) {
    io.to(room.id).emit('chatBroadcast', {
        sender: 'SİSTEM',
        msg: msg,
        type: 'log',
        time: ''
    });
    room.logs.push(msg);
    if(room.logs.length > 6) room.logs.shift();
}

function getActiveSide(card, currentSide) {
    if (card.sides) {
        return card.sides[currentSide] || card.sides.light;
    }
    return card;
}

function formatCardName(card) {
    if(!card) return "Bilinmeyen Kart";
    
    if(card.color === 'black') return card.value === 'wild' ? 'Joker' : '+4 Joker';
    if(card.color === 'dark-black') {
        if(card.value === 'wilddrawcolor') return 'Wild Draw Color';
        return card.value === 'wild' ? 'Joker (Karanlık)' : 'Wild Card';
    }
    
    const colorMap = {
        'red': 'Kırmızı', 'blue': 'Mavi', 'green': 'Yeşil', 'yellow': 'Sarı',
        'pink': 'Pembe', 'teal': 'Turkuaz', 'orange': 'Turuncu', 'purple': 'Mor'
    };
    
    const colorName = colorMap[card.color] || card.color;
    
    const valueMap = {
        'skip': 'Engel', 'reverse': 'Yön Değiştir', 'draw2': '+2', 'draw1': '+1',
        'draw5': '+5', 'skipall': 'Herkesi Atla', 'flip': 'Flip', 'wilddrawcolor': 'Wild Draw Color'
    };
    
    const valueName = valueMap[card.value] || card.value;
    
    return `${colorName} ${valueName}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    const topCard = room.discardPile[room.discardPile.length-1];
    
    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                gameMode: room.gameMode,
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id),
                    totalScore: pl.totalScore || 0
                })),
                myHand: p.hand,
                topCard: topCard,
                currentColor: room.currentColor,
                currentSide: room.currentSide,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname,
                isMyTurn: room.players[room.turnIndex].id === p.id,
                turnDeadline: room.turnDeadline,
                pendingChallenge: !!room.pendingChallenge,
                pendingDrawAction: room.pendingDrawAction && room.pendingDrawAction.playerId === p.id,
                pendingWildDrawColor: !!room.pendingWildDrawColor
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Legend Server Aktif! (Classic + Flip Modları)'));
