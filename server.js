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

// UNO X (Flip) Renkleri:
// Light: red, blue, green, yellow
// Dark: pink, teal, orange, purple

function createDeck(gameMode) {
    const deck = [];
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    // UNO X için Karanlık Taraf renkleri (Sırasıyla light renklerle eşleşir varsayalım mekanik için)
    const darkColors = ['pink', 'teal', 'orange', 'purple']; 

    if (gameMode === 'CLASSIC') {
        lightColors.forEach(color => {
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
    } 
    else if (gameMode === 'UNOX') {
        // UNO X - Çift Taraflı Kartlar
        // Basitleştirilmiş üretim: Her Light kartın bir Dark karşılığı vardır.
        
        lightColors.forEach((lColor, idx) => {
            const dColor = darkColors[idx];

            // Sayılar (Light 1-9 -> Dark 1-9)
            // Light 0 -> Dark Skip Everyone (Örnek eşleşme)
            deck.push(createDualCard(lColor, '0', dColor, 'skip_all', 50));

            for (let i = 1; i <= 9; i++) {
                // Çift kopya
                deck.push(createDualCard(lColor, i.toString(), dColor, i.toString(), i));
                deck.push(createDualCard(lColor, i.toString(), dColor, i.toString(), i));
            }

            // Aksiyonlar
            // Light Draw 1 -> Dark Draw 5
            deck.push(createDualCard(lColor, 'draw1', dColor, 'draw5', 20));
            deck.push(createDualCard(lColor, 'draw1', dColor, 'draw5', 20));

            // Light Skip -> Dark Skip Everyone (veya düz Skip)
            deck.push(createDualCard(lColor, 'skip', dColor, 'skip_all', 30)); 
            deck.push(createDualCard(lColor, 'skip', dColor, 'skip_all', 30));

            // Light Reverse -> Dark Reverse
            deck.push(createDualCard(lColor, 'reverse', dColor, 'reverse', 20));
            deck.push(createDualCard(lColor, 'reverse', dColor, 'reverse', 20));

            // Light Flip -> Dark Flip
            deck.push(createDualCard(lColor, 'flip', dColor, 'flip', 20));
            deck.push(createDualCard(lColor, 'flip', dColor, 'flip', 20));
        });

        // Wild Kartlar
        for(let i=0; i<4; i++) {
            // Light Wild -> Dark Wild Color
            deck.push(createDualCard('black', 'wild', 'black', 'wild_color', 60));
            // Light Wild Draw 2 -> Dark Wild Color (veya Draw 5) - Dengeli dağılım
            deck.push(createDualCard('black', 'wild_draw2', 'black', 'wild', 50)); 
        }
    }

    return shuffle(deck);
}

function createDualCard(lColor, lVal, dColor, dVal, score) {
    return {
        id: Math.random().toString(36),
        score: score,
        // Aktif taraf sunucuda 'currentSide'a göre belirlenecek ama veri yapısı şöyle:
        sides: {
            light: { color: lColor, value: lVal, type: (lColor==='black' ? 'wild' : 'normal') },
            dark: { color: dColor, value: dVal, type: (dColor==='black' ? 'wild' : 'normal') }
        },
        // Geriye uyumluluk için varsayılan light değerleri kök dizinde de tutulabilir veya dinamik çözülür.
        // Biz dinamik çözüm kullanacağız.
        color: lColor, // Başlangıç
        value: lVal    // Başlangıç
    };
}

function getActiveCardData(card, side) {
    if (!card.sides) return card; // Klasik mod kartı
    return card.sides[side];
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
            mode: r.gameMode // MODU GÖNDER
        }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, mode }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;

        const roomId = generateRoomId();
        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            gameMode: mode || 'CLASSIC', // Varsayılan Klasik
            currentSide: 'light', // UNO X için (light/dark)
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
            
            if (room.deck.length < 7) { room.deck = createDeck(room.gameMode); }
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
        room.deck = createDeck(room.gameMode);
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0; 
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
            // UNO X modunda Flip kartı gelirse tekrar karıştır (basitlik için)
            const activeData = getActiveCardData(first, room.currentSide);
            if (activeData.value === 'wild4' || activeData.value === 'flip') {
                room.deck.push(first);
                room.deck = shuffle(room.deck);
            }
        } while (false); // Loop condition basitleştirildi
        
        room.discardPile.push(first);
        const activeFirst = getActiveCardData(first, room.currentSide);
        
        if (activeFirst.color === 'black') { 
            room.currentColor = null; 
            addLog(room, "Joker açıldı! İlk oyuncu rengi belirliyor.");
        } else {
            room.currentColor = activeFirst.color;
        }

        // Başlangıç etkileri (Basitleştirildi: Sadece renk ve görsel)
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
        
        let drawnCard = null;
        if(room.deck.length === 0) {
             if(room.discardPile.length > 1) {
                 const top = room.discardPile.pop();
                 room.deck = shuffle(room.discardPile);
                 room.discardPile = [top];
             } else {
                 room.deck = createDeck(room.gameMode); // Kart kalmadıysa yarat
             }
        }
        if(room.deck.length > 0) drawnCard = room.deck.pop();
        else return;

        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        // Oynanabilirlik kontrolü (Aktif yüze göre)
        const activeDrawn = getActiveCardData(drawnCard, room.currentSide);
        const topCard = room.discardPile[room.discardPile.length - 1];
        const activeTop = getActiveCardData(topCard, room.currentSide);

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
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const activeCard = getActiveCardData(card, room.currentSide);
            const oldColor = room.currentColor;
            room.currentColor = (activeCard.color === 'black') ? chosenColor : activeCard.color;
            
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
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const activeCard = getActiveCardData(card, room.currentSide); // Aktif yüze bak
        
        const top = room.discardPile[room.discardPile.length - 1];
        const activeTop = getActiveCardData(top, room.currentSide);

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
            handleCardEffect(room, activeCard, player, oldColorForChallenge);
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
            // Wild4 için renk kontrolü (Aktif yüze göre)
            const hasColor = attacker.hand.some(c => {
                const ac = getActiveCardData(c, room.currentSide);
                return ac.color === oldColor && ac.color !== 'black';
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
        room.logs = [];
        room.turnDeadline = 0;
        
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

// --- OYUN MANTIĞI & EFEKTLER ---

function handleCardEffect(room, activeCard, player, oldColorForChallenge) {
    let skipNext = false;

    // UNO X (Flip) Efekti
    if (activeCard.value === 'flip') {
        room.currentSide = (room.currentSide === 'light') ? 'dark' : 'light';
        addLog(room, `🌀 DÜNYA TERSİNE DÖNDÜ! Şimdi ${room.currentSide.toUpperCase()} taraf!`);
        // Desteyi ve ıskartayı ters çevir (sanal olarak)
        // Kartlar zaten çift taraflı, sadece 'currentSide' değiştiğinde client'a giden veri değişecek.
        
        // Yeni renge güncelle (ıskartanın en üstündeki kartın YENİ yüzü geçerli renk olur)
        const top = room.discardPile[room.discardPile.length - 1];
        const newActiveTop = getActiveCardData(top, room.currentSide);
        room.currentColor = newActiveTop.color;
    }

    // Ortak Aksiyonlar
    if (activeCard.value === 'skip') { 
        skipNext = true; 
        addLog(room, "Sıra atladı!"); 
    } 
    else if (activeCard.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) { skipNext = true; } 
    }
    else if (activeCard.value === 'draw2' || activeCard.value === 'draw1') { // Draw 1 (Light), Draw 2 (Classic)
        const next = getNextPlayer(room);
        const count = (activeCard.value === 'draw2') ? 2 : 1;
        drawCards(room, next, count);
        addLog(room, `${next.nickname} +${count} yedi!`);
        skipNext = true;
    }
    
    // UNO X - Karanlık Aksiyonlar
    else if (activeCard.value === 'draw5') {
        const next = getNextPlayer(room);
        drawCards(room, next, 5);
        addLog(room, `💀 ${next.nickname} +5 YEDİ!`);
        skipNext = true;
    }
    else if (activeCard.value === 'skip_all') {
        addLog(room, `⛔ HERKES ATLANDI! ${player.nickname} tekrar oynuyor.`);
        // Sıra değişmeyecek, tekrar bu oyuncuda
        broadcastGameState(room.id);
        startTurnTimer(room);
        return; 
    }
    else if (activeCard.value === 'wild_color') { // Wild Draw Color
        // Basitlik için +10 kart çektirip geçiyoruz (Gerçek kural: renk gelene kadar)
        // Ancak oyun akışını bozmamak için +5 olarak uygulayalım şimdilik
        const next = getNextPlayer(room);
        drawCards(room, next, 5); 
        addLog(room, `${next.nickname} renk cezası aldı (+5)!`);
        skipNext = true;
    }

    // Wild 4 Challenge
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

        if (room.pendingDrawAction) {
            addLog(room, `⏳ ${currentPlayer.nickname} karar vermedi, pas geçildi.`);
            room.pendingDrawAction = null;
            advanceTurn(room);
        } else {
            drawCards(room, currentPlayer, 1);
            addLog(room, `⏳ ${currentPlayer.nickname} süre doldu.`);
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
                // Aktif tarafın puanını topla
                const ac = getActiveCardData(c, room.currentSide);
                roundScore += (ac.score || 0);
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
                room.deck = createDeck(room.gameMode);
            }
        }
        if(room.deck.length > 0) {
            player.hand.push(room.deck.pop());
        }
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
    io.to(room.id).emit('chatBroadcast', {
        sender: 'SİSTEM',
        msg: msg,
        type: 'log',
        time: ''
    });
    room.logs.push(msg);
    if(room.logs.length > 6) room.logs.shift();
}

function formatCardName(c) {
    if(c.color === 'black') return 'Joker';
    // Action isimlerini düzelt
    if(c.value === 'draw5') return 'TURUNCU +5';
    if(c.value === 'skip_all') return 'HERKESİ ATLA';
    if(c.value === 'flip') return 'FLIP';
    return `${c.color.toUpperCase()} ${c.value}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            // Client'a sadece görmesi gereken yüzü gönder
            // Kural: Kendi elinin aktif yüzü, Rakibin elinin arka yüzü
            // Ama basitlik için istemciye kartın tamamını gönderip CSS ile yönetmiyoruz, 
            // Direkt aktif veriyi gönderiyoruz.
            const myHandView = p.hand.map(c => getActiveCardData(c, room.currentSide));
            const topCardView = getActiveCardData(room.discardPile[room.discardPile.length-1], room.currentSide);

            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                gameMode: room.gameMode,
                currentSide: room.currentSide, // Client temayı buna göre değiştirecek
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id),
                    totalScore: pl.totalScore || 0
                })),
                myHand: myHandView,
                topCard: topCardView,
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
