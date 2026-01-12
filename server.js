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

// --- KART OLUŞTURMA MANTIĞI ---

function createCardObj(color, value, type, score) {
    return {
        id: Math.random().toString(36),
        sides: {
            light: { color, value, type, score },
            dark: { color, value, type, score } // Klasik modda kopya
        }
    };
}

// Klasik Mod Destesi
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

// UNO FLIP Destesi
function createFlipDeck() {
    const deck = [];
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    const darkColors = ['pink', 'teal', 'orange', 'purple'];

    let lightCards = [];
    let darkCards = [];

    // --- LIGHT SIDE GENERATION ---
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

    // --- DARK SIDE GENERATION ---
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

    // Kartları karıştır ve birleştir
    lightCards = shuffle(lightCards);
    darkCards = shuffle(darkCards);

    const minLen = Math.min(lightCards.length, darkCards.length);
    for(let i=0; i<minLen; i++) {
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: lightCards[i],
                dark: darkCards[i]
            }
        });
    }

    return shuffle(deck);
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
            mode: r.gameMode,
            count: r.players.length, 
            status: r.gameState 
        }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, gameMode }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;

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
            drawStack: 0,
            timer: null,
            turnDeadline: 0
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
            
            if (room.gameState === 'PLAYING') {
                if (room.deck.length < 7) { 
                    room.deck = (room.gameMode === 'flip') ? createFlipDeck() : createClassicDeck(); 
                }
                newPlayer.hand = room.deck.splice(0, 7);
            }
            
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
        room.deck = (room.gameMode === 'flip') ? createFlipDeck() : createClassicDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0;
        room.currentSide = 'light';
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        room.pendingDrawAction = null;
        room.drawStack = 0;
        
        room.players.forEach(p => { 
            p.hand = room.deck.splice(0, 7); 
            p.cardCount = 7;
            p.hasUno = false;
        });

        // İlk kartı aç
        let first;
        do {
            first = room.deck.pop();
            const sideData = first.sides[room.currentSide];
            // Başlangıçta çok kompleks kartları geri at (basitlik için)
            if (sideData.value === 'wild4' || sideData.value === 'wild_draw_color' || sideData.value === 'wild_draw2') {
                room.deck.unshift(first);
                room.deck = shuffle(room.deck);
                first = null;
            }
        } while (!first);
        
        room.discardPile.push(first);
        const activeFirst = first.sides[room.currentSide];
        
        if (activeFirst.color === 'black') {
            room.currentColor = null; 
            addLog(room, "Joker açıldı! İlk oyuncu rengi belirliyor.");
        } else {
            room.currentColor = activeFirst.color;
        }

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
        if (room.pendingChallenge) return;
        if (room.pendingDrawAction) return;

        resetTurnTimer(room);

        // --- STACK VARSA VE OYUNCU KART ÇEKİYORSA (PAS GEÇMEK VEYA CEZA YEMEK) ---
        if (room.drawStack > 0) {
            addLog(room, `${player.nickname} komboyu karşılayamadı ve ${room.drawStack} kart çekti!`);
            drawCards(room, player, room.drawStack);
            room.drawStack = 0; 
            advanceTurn(room);
            broadcastGameState(roomId);
            startTurnTimer(room);
            return;
        }
        
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
            socket.emit('drawDecisionRequired', { 
                card: activeSide, 
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
            
            // Eğer kart attıktan sonra elinde 1 kart kalıyorsa (draw + play = aynı sayı)
            // Ama burası "çekip oynama" olduğu için, 
            // Kartı çekti (el sayısı arttı), oynadı (el sayısı azaldı).
            // Sonuçta 1 kart kaldıysa ve UNO demediyse ceza.
            if (player.hand.length === 1 && !room.unoCallers.has(player.id)) {
                addLog(room, `🚨 OTOMATİK CEZA! ${player.nickname} UNO demeyi unuttu! (+2 Kart)`);
                drawCards(room, player, 2);
            }
            // Kart sayısı 1 değilse flag'i temizle
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} çektiği kartı oynadı: ${formatCardName(activeCard)}`);
            room.pendingDrawAction = null;
            handleCardEffect(room, activeCard, player, oldColor);

        } else {
            addLog(room, `${player.nickname} pas geçti.`);
            room.pendingDrawAction = null;
            advanceTurn(room);
            broadcastGameState(roomId);
            startTurnTimer(room);
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
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const activeCard = card.sides[room.currentSide];
        const topCardObj = room.discardPile[room.discardPile.length - 1];
        const topActive = topCardObj.sides[room.currentSide];
        
        let isValid = false;

        // STACKING KONTROLÜ (Sadece Flip Modunda)
        if (room.gameMode === 'flip' && room.drawStack > 0) {
            // Sadece aynı tip ceza kartı atılabilir
            const canStack = (activeCard.value === topActive.value) || 
                             (activeCard.value === 'wild4' && topActive.value === 'wild4') ||
                             (activeCard.value === 'wild_draw2' && topActive.value === 'wild_draw2') ||
                             (activeCard.value === 'draw5' && topActive.value === 'draw5');
            
            if (!canStack) {
                socket.emit('error', `Ortada +${room.drawStack} ceza var! Sadece aynı tip ceza kartı atabilirsin.`);
                return;
            }
            isValid = true;
        } else {
            // Normal oynama kuralları (Klasik veya Flip Stack=0)
            if (activeCard.color === 'black') isValid = true;
            else if (activeCard.color === room.currentColor) isValid = true;
            else if (activeCard.value === topActive.value) isValid = true;
            if (room.currentColor === null && activeCard.color !== 'black') isValid = true;
        }

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (activeCard.color === 'black') ? chosenColor : activeCard.color;

            // --- OTOMATİK UNO KONTROLÜ ---
            // Oyuncu kartı attı. Şu an elinde 1 kart mı kaldı?
            if (player.hand.length === 1) {
                // Eğer önceden butona basmadıysa ceza yer
                if (!room.unoCallers.has(player.id)) {
                    addLog(room, `🚨 OTOMATİK CEZA! ${player.nickname} UNO demeyi unuttu! (+2 Kart)`);
                    drawCards(room, player, 2);
                    room.unoCallers.add(player.id); // Cezayı yedi, loop'a girmesin
                } else {
                    addLog(room, `✅ ${player.nickname} UNO dediği için güvende.`);
                }
            } else {
                // Kart sayısı 1 değilse UNO durumunu sıfırla
                room.unoCallers.delete(player.id);
            }

            addLog(room, `${player.nickname} attı: ${formatCardName(activeCard)}`);
            handleCardEffect(room, activeCard, player, oldColorForChallenge);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
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

    socket.on('callUno', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        
        // 2 kart varken (birini atacak) basabilir
        if (player.hand.length <= 2) {
            if (!room.unoCallers.has(player.id)) {
                room.unoCallers.add(player.id);
                addLog(room, `📢 ${player.nickname} UNO Dedi!`);
                io.to(roomId).emit('playSound', 'uno');
                broadcastGameState(roomId);
            }
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
            room.drawStack = 0; 
            advanceTurn(room); 
        } else {
            const hasColor = attacker.hand.some(c => {
                const side = c.sides[room.currentSide];
                return side.color === oldColor && side.color !== 'black';
            });
            
            if (hasColor) {
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yapmıştı! (Ceza: 4 Kart)`);
                drawCards(room, attacker, 4);
                // Blöf yakalanırsa ceza atana gider, kurban oynamaya devam eder (sıra geçmez)
                room.drawStack = 0;
                // Kural gereği sıra kurbanda olmalı ama basitlik için devam ettiriyoruz.
                // İdeal: pendingChallenge bitince kimin sırası?
                // Normalde +4 atan oynadı, sıra kurbana geçti. Kurban challenge yaptı.
                // Eğer atan ceza yerse, kurban kart çekmez ve OYNAR.
                // Bu yüzden advanceTurn YAPMIYORUZ.
                broadcastGameState(roomId);
                startTurnTimer(room);
                return;
            } else {
                addLog(room, `⚖️ TEMİZ! ${attacker.nickname} dürüsttü. ${victim.nickname} 6 kart çekiyor!`);
                drawCards(room, victim, 6);
                room.drawStack = 0;
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
        room.turnDeadline = 0;
        room.currentSide = 'light';
        room.drawStack = 0;
        
        io.to(roomId).emit('gameReset', { roomId });
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

// --- OYUN MANTIĞI & EFEKTLER (KESİN AYRIŞTIRMA) ---

function handleInitialCardEffect(room, card) {
    // Başlangıçta sadece basit efektler
    if (card.value === 'skip') {
        advanceTurn(room);
    } else if (card.value === 'reverse') {
        room.direction *= -1;
        if (room.players.length === 2) advanceTurn(room);
        else room.turnIndex = room.players.length - 1;
    } else if (card.value === 'draw2') {
        // Klasik başlangıç: İlk oyuncu çeker ve sıra geçer
        const first = room.players[room.turnIndex];
        drawCards(room, first, 2);
        advanceTurn(room);
    }
}

function handleCardEffect(room, card, player, oldColorForChallenge) {
    let nextPlayer = getNextPlayer(room);
    let isFlipMode = (room.gameMode === 'flip');

    // 1. ORTAK EFEKTLER (Skip, Reverse)
    if (card.value === 'skip') {
        addLog(room, "Sıra atladı!");
        advanceTurn(room); // Bir sonraki oyuncuyu atla
        advanceTurn(room); // Sıra ondan sonrakine geçsin
        finalizeTurn(room, player);
        return;
    } 
    
    if (card.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) {
            // 2 kişide reverse = skip
            advanceTurn(room);
            advanceTurn(room);
        } else {
            advanceTurn(room);
        }
        finalizeTurn(room, player);
        return;
    }

    // 2. KLASİK MOD ÖZEL MANTIĞI
    if (!isFlipMode) {
        if (card.value === 'draw2') {
            // Klasikte stack yok, direkt ceza
            addLog(room, `${nextPlayer.nickname} +2 yedi!`);
            drawCards(room, nextPlayer, 2);
            advanceTurn(room); // Cezayı yiyen oynayamaz
            advanceTurn(room);
        } 
        else if (card.value === 'wild4') {
            room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor: oldColorForChallenge };
            io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
            broadcastGameState(room.id);
            return; // Challenge bekleniyor
        } 
        else {
            // Normal sayı veya wild
            advanceTurn(room);
        }
        finalizeTurn(room, player);
        return;
    }

    // 3. FLIP MODU ÖZEL MANTIĞI (Stacking Var)
    if (isFlipMode) {
        
        // FLIP KARTI
        if (card.value === 'flip') {
            room.currentSide = (room.currentSide === 'light') ? 'dark' : 'light';
            addLog(room, `🌀 DÜNYA DÖNDÜ! Taraf: ${room.currentSide.toUpperCase()}`);
            io.to(room.id).emit('playSound', 'turn');
            // Renk güncelle
            const topCardObj = room.discardPile[room.discardPile.length - 1];
            const newSide = topCardObj.sides[room.currentSide];
            if (newSide.color !== 'black') {
                 room.currentColor = newSide.color;
            }
            advanceTurn(room);
            finalizeTurn(room, player);
            return;
        }

        // KOMBO / STACK KARTLARI
        let addedStack = 0;
        if (card.value === 'draw1') addedStack = 1;
        else if (card.value === 'draw2') addedStack = 2; // (Eğer klasikten kalan varsa, ama flip deckte draw1 var)
        else if (card.value === 'wild_draw2') addedStack = 2;
        else if (card.value === 'draw5') addedStack = 5;
        else if (card.value === 'wild4') addedStack = 4;

        if (addedStack > 0) {
            room.drawStack += addedStack;
            addLog(room, `Kombo! Ortadaki ceza: +${room.drawStack} kart!`);
            
            if (card.value === 'wild4') {
                // Wild Draw 4 Flipte de challenge tetikler mi? Evet.
                room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor: oldColorForChallenge };
                io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
                broadcastGameState(room.id);
                return;
            } else {
                advanceTurn(room);
                finalizeTurn(room, player);
                return;
            }
        }

        // DİĞER FLIP KARTLARI
        if (card.value === 'skip_everyone') {
            addLog(room, "⛔ HERKESİ ATLA! Sıra tekrar sende.");
            // Sıra ilerlemez
            finalizeTurn(room, player);
            return;
        }
        else if (card.value === 'wild_draw_color') {
            addLog(room, `🎨 ${nextPlayer.nickname}, ${room.currentColor.toUpperCase()} bulana kadar çekiyor!`);
            let drawnCount = 0;
            let found = false;
            while(!found && drawnCount < 20) {
                ensureDeck(room);
                if(room.deck.length === 0) break;
                const drawn = room.deck.pop();
                nextPlayer.hand.push(drawn);
                drawnCount++;
                if (drawn.sides[room.currentSide].color === room.currentColor) found = true;
            }
            addLog(room, `${nextPlayer.nickname} toplam ${drawnCount} kart çekti.`);
            advanceTurn(room); // Cezayı yiyen oynayamaz
            advanceTurn(room);
            finalizeTurn(room, player);
            return;
        }

        // Standart kart
        advanceTurn(room);
        finalizeTurn(room, player);
    }
}

function finalizeTurn(room, player) {
    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }
    broadcastGameState(room.id);
    startTurnTimer(room);
}

function ensureDeck(room) {
    if(room.deck.length === 0 && room.discardPile.length > 1) {
        const top = room.discardPile.pop();
        room.deck = shuffle(room.discardPile);
        room.discardPile = [top];
        addLog(room, "♻️ Deste karıştırıldı.");
    }
}

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    room.turnDeadline = Date.now() + 15000; // 15 Saniye süre
    
    room.timer = setTimeout(() => {
        if(!rooms.has(room.id)) return;
        const currentPlayer = room.players[room.turnIndex];
        if (!currentPlayer) return;

        // Süre bitince otomatik işlem
        if (room.drawStack > 0) {
            addLog(room, `⏳ ${currentPlayer.nickname} süre doldu, cezayı (+${room.drawStack}) çekti.`);
            drawCards(room, currentPlayer, room.drawStack);
            room.drawStack = 0;
        } else {
            addLog(room, `⏳ ${currentPlayer.nickname} süre doldu, 1 kart çekti.`);
            drawCards(room, currentPlayer, 1);
        }
        
        room.pendingDrawAction = null;
        advanceTurn(room);
        broadcastGameState(room.id);
        startTurnTimer(room);
    }, 15000);
}

function resetTurnTimer(room) { if(room.timer) clearTimeout(room.timer); }

function finishGame(room, winner) {
    if(room.timer) clearTimeout(room.timer);
    room.turnDeadline = 0;
    
    let roundScore = 0;
    room.players.forEach(p => {
        if (p.id !== winner.id) {
            p.hand.forEach(c => roundScore += c.sides[room.currentSide].score);
        }
    });

    if (!winner.totalScore) winner.totalScore = 0;
    winner.totalScore += roundScore;

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
        ensureDeck(room);
        if(room.deck.length > 0) {
            player.hand.push(room.deck.pop());
        }
    }
}

function advanceTurn(room) {
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function getNextPlayer(room) {
    return room.players[(room.turnIndex + room.direction + room.players.length) % room.players.length];
}

function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}

function addLog(room, msg) {
    io.to(room.id).emit('chatBroadcast', { sender: 'SİSTEM', msg: msg, type: 'log', time: '' });
    room.logs.push(msg);
    if(room.logs.length > 6) room.logs.shift();
}

function formatCardName(c) {
    if(c.color === 'black') {
        if (c.value === 'wild') return 'Joker';
        if (c.value === 'wild4') return '+4 Joker';
        if (c.value === 'wild_draw_color') return 'Renk Çektir';
        if (c.value === 'wild_draw2') return 'Joker +2';
    } 
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
                gameMode: room.gameMode,
                currentSide: room.currentSide,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id),
                    totalScore: pl.totalScore || 0
                })),
                myHand: p.hand,
                topCard: room.discardPile[room.discardPile.length-1],
                currentColor: room.currentColor,
                logs: room.logs,
                turnOwner: room.players[room.turnIndex].nickname,
                isMyTurn: room.players[room.turnIndex].id === p.id,
                turnDeadline: room.turnDeadline,
                pendingChallenge: !!room.pendingChallenge,
                pendingDrawAction: room.pendingDrawAction && room.pendingDrawAction.playerId === p.id,
                drawStack: room.drawStack 
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Final Server Aktif!'));
