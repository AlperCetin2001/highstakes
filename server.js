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

// --- DESTE OLUŞTURUCULAR ---

// 1. KLASİK DESTE (Eski Mantık)
function createClassicDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];
    colors.forEach(color => {
        deck.push({ mode: 'classic', color, value: '0', type: 'number', score: 0, id: Math.random().toString(36) });
        for (let i = 1; i <= 9; i++) {
            deck.push({ mode: 'classic', color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
            deck.push({ mode: 'classic', color, value: i.toString(), type: 'number', score: i, id: Math.random().toString(36) });
        }
        ['skip', 'reverse', 'draw2'].forEach(val => {
            deck.push({ mode: 'classic', color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
            deck.push({ mode: 'classic', color, value: val, type: 'action', score: 20, id: Math.random().toString(36) });
        });
    });
    for (let i = 0; i < 4; i++) {
        deck.push({ mode: 'classic', color: 'black', value: 'wild', type: 'wild', score: 50, id: Math.random().toString(36) });
        deck.push({ mode: 'classic', color: 'black', value: 'wild4', type: 'wild', score: 50, id: Math.random().toString(36) });
    }
    return shuffle(deck);
}

// 2. FLIP DESTESİ (Çift Taraflı)
function createFlipDeck() {
    // Flip destesinde kartlar eşleşir. Biz burada rastgele eşleştirme yerine 
    // standart bir set oluşturup bunları "Card" objesi içinde birleştireceğiz.
    
    // Light Side (Aydınlık): Classic benzeri ama +2 yerine +1, Wild Draw 2, Flip kartı var.
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    let lightCards = [];
    
    // Dark Side (Karanlık): Teal, Orange, Pink, Purple. +5, Skip Everyone, Wild Draw Color, Flip.
    const darkColors = ['teal', 'orange', 'pink', 'purple'];
    let darkCards = [];

    // --- LIGHT SIDE OLUŞTURMA ---
    lightColors.forEach(color => {
        lightCards.push({ color, value: '1', score: 1, type: 'number' }); // 1-9 (0 yok genelde flipte ama basitleştirdik)
        for(let i=1; i<=9; i++) {
            lightCards.push({ color, value: i.toString(), score: i, type: 'number' });
            lightCards.push({ color, value: i.toString(), score: i, type: 'number' });
        }
        ['draw1', 'skip', 'reverse', 'flip'].forEach(val => {
            lightCards.push({ color, value: val, score: 20, type: 'action' });
            lightCards.push({ color, value: val, score: 20, type: 'action' });
        });
    });
    // Light Wilds
    for(let i=0; i<4; i++) {
        lightCards.push({ color: 'black', value: 'wild', score: 40, type: 'wild' });
        lightCards.push({ color: 'black', value: 'wild_draw2', score: 50, type: 'wild' });
    }

    // --- DARK SIDE OLUŞTURMA ---
    // (Light kart sayısıyla eşitlemek için benzer döngü)
    darkColors.forEach(color => {
        darkCards.push({ color, value: '1', score: 1, type: 'number' });
        for(let i=1; i<=9; i++) {
            darkCards.push({ color, value: i.toString(), score: i, type: 'number' });
            darkCards.push({ color, value: i.toString(), score: i, type: 'number' });
        }
        ['draw5', 'skip_everyone', 'reverse', 'flip'].forEach(val => {
            darkCards.push({ color, value: val, score: 20, type: 'action' });
            darkCards.push({ color, value: val, score: 20, type: 'action' });
        });
    });
    // Dark Wilds
    for(let i=0; i<4; i++) {
        darkCards.push({ color: 'black', value: 'wild', score: 40, type: 'wild' });
        darkCards.push({ color: 'black', value: 'wild_draw_color', score: 60, type: 'wild' });
    }

    // Desteleri Karıştırıp Birleştirme
    lightCards = shuffle(lightCards);
    darkCards = shuffle(darkCards);

    const fullDeck = [];
    // Light ve Dark kartları birebir eşleştiriyoruz
    const count = Math.min(lightCards.length, darkCards.length);
    for(let i=0; i<count; i++) {
        fullDeck.push({
            id: Math.random().toString(36),
            mode: 'flip',
            sides: {
                light: lightCards[i],
                dark: darkCards[i]
            }
        });
    }
    
    return shuffle(fullDeck);
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
            id: r.id, name: r.name, count: r.players.length, status: r.gameState, mode: r.mode 
        }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, mode }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;

        const roomId = generateRoomId();
        const selectedMode = mode || 'classic'; // Varsayılan klasik

        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            mode: selectedMode, // 'classic' veya 'flip'
            currentSide: 'light', // Flip modu için: 'light' veya 'dark'
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
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
                room.deck = (room.mode === 'flip') ? createFlipDeck() : createClassicDeck();
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
        room.currentSide = 'light'; // Her zaman light başlar
        room.deck = (room.mode === 'flip') ? createFlipDeck() : createClassicDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = Math.floor(Math.random() * room.players.length);
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        room.pendingDrawAction = null;
        
        room.players.forEach(p => { 
            p.hand = room.deck.splice(0, 7); 
            p.cardCount = 7;
            p.hasUno = false;
        });

        // İlk kartı aç
        let first;
        do {
            first = room.deck.pop();
            // Flip modunda wild kartlar veya flip kartı başta gelirse tekrar karıştır (Basitlik için)
            // Klasik modda wild4 gelirse tekrar karıştır
            let activeFace = getActiveFace(first, room.currentSide);
            if (activeFace.value === 'wild4' || activeFace.value === 'wild_draw_color' || activeFace.value === 'flip') {
                room.deck.push(first);
                room.deck = shuffle(room.deck);
                first = null;
            }
        } while (!first);
        
        room.discardPile.push(first);
        let activeFirst = getActiveFace(first, room.currentSide);
        
        if (activeFirst.color === 'black') { 
            room.currentColor = null; 
            addLog(room, "Joker açıldı! İlk oyuncu rengi belirliyor.");
        } else {
            room.currentColor = activeFirst.color;
        }

        // Başlangıç kartı etkileri
        if (activeFirst.value === 'skip') { advanceTurn(room); }
        else if (activeFirst.value === 'reverse') {
            room.direction *= -1;
            if (room.players.length > 2) room.turnIndex = room.players.length - 1;
            else advanceTurn(room);
        }
        else if (activeFirst.value === 'draw2' || activeFirst.value === 'draw1' || activeFirst.value === 'draw5') {
             // Başlangıçta ceza verilmez kuralı (Ev kuralı), pas geçilir.
        }
        
        addLog(room, `Oyun Başladı! Mod: ${room.mode.toUpperCase()}`);
        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingDrawAction) return;

        resetTurnTimer(room);
        
        const drawnCard = pullCardFromDeck(room);
        if(!drawnCard) return;

        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        // Çekilen kart oynanabilir mi?
        const activeDrawn = getActiveFace(drawnCard, room.currentSide);
        const top = room.discardPile[room.discardPile.length - 1];
        const activeTop = getActiveFace(top, room.currentSide);

        let isPlayable = false;
        if (activeDrawn.color === 'black') isPlayable = true;
        else if (room.currentColor && activeDrawn.color === room.currentColor) isPlayable = true;
        else if (activeDrawn.value === activeTop.value) isPlayable = true;

        if (isPlayable) {
            room.pendingDrawAction = { playerId: player.id, cardId: drawnCard.id };
            socket.emit('drawDecisionRequired', { 
                card: activeDrawn, // Sadece aktif yüzü gönder
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
            const activeCard = getActiveFace(card, room.currentSide);

            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColor = room.currentColor;
            room.currentColor = (activeCard.color === 'black') ? chosenColor : activeCard.color;
            
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} çektiği kartı oynadı: ${formatCardName(activeCard)}`);
            room.pendingDrawAction = null;
            handleCardEffect(room, card, player, oldColor); // Efektleri işle

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
        if (room.pendingDrawAction) return; 
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const activeCard = getActiveFace(card, room.currentSide); // Aktif yüze göre kontrol

        const top = room.discardPile[room.discardPile.length - 1];
        const activeTop = getActiveFace(top, room.currentSide);
        
        let isValid = false;
        if (activeCard.color === 'black') isValid = true;
        else if (activeCard.color === room.currentColor) isValid = true;
        else if (activeCard.value === activeTop.value) isValid = true;
        if (room.currentColor === null && activeCard.color !== 'black') isValid = true;

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (activeCard.color === 'black') ? chosenColor : activeCard.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(activeCard)}`);
            handleCardEffect(room, card, player, oldColorForChallenge);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

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

    socket.on('catchUnoFailure', () => {
        const roomId = getPlayerRoomId(socket.id);
        const room = rooms.get(roomId);
        if(!room) return;
        
        let caughtSomeone = false;
        room.players.forEach(p => {
            if (p.hand.length === 1 && !room.unoCallers.has(p.id)) {
                addLog(room, `🚨 YAKALANDI! ${p.nickname} UNO demeyi unuttu! (+2 Kart)`);
                drawCards(room, p, 2);
                caughtSomeone = true;
            }
        });

        if (caughtSomeone) broadcastGameState(roomId);
        else socket.emit('error', 'Yakalanacak kimse yok!');
    });

    socket.on('challengeDecision', ({ decision }) => { /* Wild 4 challenge mantığı aynı kalacak */ 
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
            // Kontrol: Attacker'ın elinde o anki renkten kart var mıydı? (Aktif yüze bakılır)
            const hasColor = attacker.hand.some(c => {
                const active = getActiveFace(c, room.currentSide);
                return active.color === oldColor && active.color !== 'black';
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
        room.players.forEach(p => { p.hand = []; p.cardCount = 0; p.hasUno = false; });
        room.deck = []; room.discardPile = []; room.pendingChallenge = null; room.logs = []; room.turnDeadline = 0;
        io.to(roomId).emit('gameReset', { roomId });
        broadcastGameState(roomId);
    });

    socket.on('chatMessage', ({ message, targetId }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const sender = room.players.find(p => p.id === socket.id);
        if(!sender) return;
        const chatData = { sender: sender.nickname, avatar: sender.avatar, msg: message, type: 'public', time: '' };
        if (targetId === 'all') {
            io.to(roomId).emit('chatBroadcast', chatData);
        } else {
            const targetSocket = io.sockets.sockets.get(targetId);
            if(targetSocket) {
                chatData.type = 'private'; chatData.to = targetSocket.data.nickname;
                socket.emit('chatBroadcast', { ...chatData, isMe: true });
                targetSocket.emit('chatBroadcast', { ...chatData, isMe: false });
            }
        }
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

// --- CORE GAME LOGIC ---

function getActiveFace(card, side) {
    if (card.mode === 'classic') return card;
    return card.sides[side]; // 'light' veya 'dark' döner
}

function handleCardEffect(room, card, player, oldColorForChallenge) {
    const activeCard = getActiveFace(card, room.currentSide);
    let skipNext = false;
    let shouldAdvance = true;

    // --- ORTAK EFEKTLER ---
    if (activeCard.value === 'skip') { 
        skipNext = true; 
        addLog(room, "Sıra atladı!"); 
    } 
    else if (activeCard.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) { skipNext = true; } 
    }
    else if (activeCard.value === 'draw2') { // Light +2
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi!`);
        skipNext = true;
    }
    else if (activeCard.value === 'draw1') { // Flip Light +1
        const next = getNextPlayer(room);
        drawCards(room, next, 1);
        addLog(room, `${next.nickname} +1 yedi!`);
        skipNext = true;
    }
    else if (activeCard.value === 'wild4') { // Classic +4
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        room.pendingChallenge = { attackerId: player.id, victimId: nextPlayer.id, oldColor: oldColorForChallenge };
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; // Beklemeye al
    }
    else if (activeCard.value === 'wild_draw2') { // Flip Light Wild Draw 2
        const next = getNextPlayer(room);
        drawCards(room, next, 2);
        addLog(room, `${next.nickname} +2 yedi (Wild)!`);
        skipNext = true;
    }

    // --- DARK SIDE ÖZEL EFEKTLER ---
    else if (activeCard.value === 'draw5') { // Dark +5
        const next = getNextPlayer(room);
        drawCards(room, next, 5);
        addLog(room, `😱 ${next.nickname} +5 YEDİ!`);
        skipNext = true;
    }
    else if (activeCard.value === 'skip_everyone') { // Dark Skip Everyone
        addLog(room, `⛔ HERKESİ ATLA! ${player.nickname} tekrar oynuyor.`);
        shouldAdvance = false; // Sıra ilerlemez, aynı oyuncuda kalır
    }
    else if (activeCard.value === 'wild_draw_color') { // Dark Wild Draw Color
        const next = getNextPlayer(room);
        const targetColor = room.currentColor; // Seçilen renk
        addLog(room, `${next.nickname}, ${targetColor.toUpperCase()} bulana kadar çekiyor...`);
        
        let drawnCount = 0;
        let found = false;
        // Max 20 kart sınırı koyalım ki sunucu çökmesin
        while(!found && drawnCount < 20) {
            const drawn = pullCardFromDeck(room);
            if(!drawn) break; // Deste bitti
            next.hand.push(drawn);
            drawnCount++;
            const face = getActiveFace(drawn, 'dark'); // Dark side kontrolü
            if (face.color === targetColor) found = true;
        }
        addLog(room, `${next.nickname} toplam ${drawnCount} kart çekti!`);
        skipNext = true; // Çeken oyuncu oynayamaz
    }
    else if (activeCard.value === 'flip') { // FLIP KARTI
        const prevSide = room.currentSide;
        room.currentSide = (prevSide === 'light') ? 'dark' : 'light';
        addLog(room, `🔄 FLIP! Oyun ${room.currentSide.toUpperCase()} tarafa döndü!`);
        // Arayüzün güncellenmesi için broadcast yeterli
    }

    if (player.hand.length === 0) {
        finishGame(room, player);
        return;
    }

    if (shouldAdvance) {
        advanceTurn(room);
        if (skipNext) advanceTurn(room);
    }
    
    broadcastGameState(room.id);
    startTurnTimer(room);
}

// Yardımcı: Desteden güvenli kart çekme (bittiğinde karıştırır)
function pullCardFromDeck(room) {
    if(room.deck.length === 0) {
        if(room.discardPile.length > 1) {
            const top = room.discardPile.pop();
            room.deck = shuffle(room.discardPile); // Çöpleri karıştırıp deste yap
            room.discardPile = [top];
        } else {
            return null; // Hiç kart kalmadı
        }
    }
    return room.deck.pop();
}

function startTurnTimer(room) {
    if(room.timer) clearTimeout(room.timer);
    room.turnDeadline = Date.now() + 60000;
    
    room.timer = setTimeout(() => {
        if(!rooms.has(room.id)) return;
        const currentPlayer = room.players[room.turnIndex];
        if (!currentPlayer) return;

        // Karar bekliyorsa pas geç
        if (room.pendingDrawAction) {
            room.pendingDrawAction = null;
            advanceTurn(room);
        } else {
            // Normal süre dolumu
            const card = pullCardFromDeck(room);
            if(card) currentPlayer.hand.push(card);
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
    let roundScore = 0;
    
    room.players.forEach(p => {
        if (p.id !== winner.id) {
            p.hand.forEach(c => {
                const active = getActiveFace(c, room.currentSide);
                roundScore += active.score;
            });
        }
    });

    if (!winner.totalScore) winner.totalScore = 0;
    winner.totalScore += roundScore;
    
    const sortedPlayers = [...room.players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    io.to(room.id).emit('gameOver', { 
        winner: winner.nickname, score: roundScore, players: sortedPlayers 
    });
    broadcastGameState(room.id);
}

function joinRoomHandler(socket, roomId, nickname, avatar) {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error', 'Oda yok.');
    socket.join(roomId);
    
    const existing = room.players.find(p => p.id === socket.id);
    if(!existing) {
        room.players.push({ id: socket.id, nickname, avatar, hand: [], score: 0, totalScore: 0 });
    }
    broadcastGameState(roomId);
}

function drawCards(room, player, count) {
    for(let i=0; i<count; i++) {
        const card = pullCardFromDeck(room);
        if(card) player.hand.push(card);
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
    io.to(room.id).emit('chatBroadcast', { sender: 'SİSTEM', msg: msg, type: 'log', time: '' });
    room.logs.push(msg);
}

function formatCardName(activeCard) {
    if(activeCard.color === 'black') return activeCard.value.replace('wild','Joker').toUpperCase();
    return `${activeCard.color.toUpperCase()} ${activeCard.value}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            // Her oyuncuya KENDİ elindeki kartların o anki aktif yüzünü gönderiyoruz
            // Destenin ve yerdeki kartın da o anki yüzü istemcide işlenecek
            const activeHand = p.hand.map(c => {
                const face = getActiveFace(c, room.currentSide);
                return { ...face, id: c.id }; // ID'yi koru, görsel veri aktif yüz
            });
            
            const topCardRaw = room.discardPile[room.discardPile.length-1];
            const activeTop = topCardRaw ? getActiveFace(topCardRaw, room.currentSide) : null;

            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                mode: room.mode,
                currentSide: room.currentSide, // Arayüz karartma için
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, nickname: pl.nickname, avatar: pl.avatar, cardCount: pl.hand.length, hasUno: room.unoCallers.has(pl.id), totalScore: pl.totalScore || 0
                })),
                myHand: activeHand, // İşlenmiş el
                topCard: activeTop, // İşlenmiş yerdeki kart
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
server.listen(PORT, () => console.log('UNO Server Aktif!'));
