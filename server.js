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

// Kart yüzünü getir (Oyun moduna ve tarafına göre)
function getCardFace(card, room) {
    if (room.mode === 'CLASSIC') {
        // Classic modda direkt kartın kendisi veya light tarafı gibi davran
        return card.sides.light; 
    } else {
        // Flip modunda currentSide (light/dark) neyse onu döndür
        return card.sides[room.currentSide];
    }
}

// --- DESTE OLUŞTURMA (MODÜLER) ---

function createClassicDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];
    
    // Helper: Klasik kart yapısı oluşturup "light" içine koyuyoruz
    const addCard = (color, value, type, score) => {
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color, value, type, score },
                dark: null // Classic modda dark taraf yok
            }
        });
    };

    colors.forEach(color => {
        addCard(color, '0', 'number', 0);
        for (let i = 1; i <= 9; i++) {
            addCard(color, i.toString(), 'number', i);
            addCard(color, i.toString(), 'number', i);
        }
        ['skip', 'reverse', 'draw2'].forEach(val => {
            addCard(color, val, 'action', 20);
            addCard(color, val, 'action', 20);
        });
    });

    for (let i = 0; i < 4; i++) {
        addCard('black', 'wild', 'wild', 50);
        addCard('black', 'wild4', 'wild', 50);
    }

    return shuffle(deck);
}

function createFlipDeck() {
    // UNO FLIP Eşleşmeleri: Kartlar rastgele oluşturulmaz, light tarafı dark tarafıyla eşleşir.
    // Ancak dijitalde her kartın arkasını rastgele oluşturmak daha kaotik ve eğlencelidir.
    // Burada denge için "Simetrik" bir yapı kuracağız.
    
    const deck = [];
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    const darkColors = ['pink', 'teal', 'orange', 'purple'];

    // Action kart sayıları
    // Light: Draw 1, Skip, Reverse, Wild, Wild Draw 2, Flip
    // Dark: Draw 5, Skip Everyone, Reverse, Wild, Wild Draw Color, Flip

    // Basit bir deste oluşturma döngüsü:
    // Her renk için 1-9 sayıları (Light) -> Karşılığı 1-9 (Dark) (Renkler map edilerek)
    
    for(let c=0; c<4; c++) {
        const lColor = lightColors[c];
        const dColor = darkColors[c];

        // 1-9 Sayılar (2'şer tane)
        for (let i = 1; i <= 9; i++) {
            for(let k=0; k<2; k++) {
                deck.push({
                    id: Math.random().toString(36),
                    sides: {
                        light: { color: lColor, value: i.toString(), type: 'number', score: i },
                        dark: { color: dColor, value: i.toString(), type: 'number', score: i }
                    }
                });
            }
        }
        
        // Aksiyonlar (Light: Draw1, Skip, Reverse) -> (Dark: Draw5, Skip Everyone, Reverse)
        // 2'şer tane
        for(let k=0; k<2; k++) {
            // Draw 1 (Light) -> Draw 5 (Dark)
            deck.push({
                id: Math.random().toString(36),
                sides: {
                    light: { color: lColor, value: 'draw1', type: 'action', score: 10 },
                    dark: { color: dColor, value: 'draw5', type: 'action', score: 20 }
                }
            });
            // Skip (Light) -> Skip Everyone (Dark)
            deck.push({
                id: Math.random().toString(36),
                sides: {
                    light: { color: lColor, value: 'skip', type: 'action', score: 20 },
                    dark: { color: dColor, value: 'skip_all', type: 'action', score: 30 }
                }
            });
            // Reverse (Light) -> Reverse (Dark)
            deck.push({
                id: Math.random().toString(36),
                sides: {
                    light: { color: lColor, value: 'reverse', type: 'action', score: 20 },
                    dark: { color: dColor, value: 'reverse', type: 'action', score: 20 }
                }
            });
            // Flip (Light) -> Flip (Dark)
            deck.push({
                id: Math.random().toString(36),
                sides: {
                    light: { color: lColor, value: 'flip', type: 'action', score: 20 },
                    dark: { color: dColor, value: 'flip', type: 'action', score: 20 }
                }
            });
        }
    }

    // Wild Kartlar
    // 4 tane Wild (Light) -> Wild (Dark)
    for(let i=0; i<4; i++) {
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'wild', type: 'wild', score: 40 },
                dark: { color: 'black', value: 'wild', type: 'wild', score: 40 }
            }
        });
    }
    
    // 4 tane Wild Draw 2 (Light) -> Wild Draw Color (Dark)
    for(let i=0; i<4; i++) {
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'draw2', type: 'wild', score: 50 }, // Flip modunda draw2 wild'dır
                dark: { color: 'black', value: 'wild_draw_color', type: 'wild', score: 60 }
            }
        });
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
            id: r.id, name: r.name, count: r.players.length, status: r.gameState, mode: r.mode
        }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, mode }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;

        const roomId = generateRoomId();
        const selectedMode = mode === 'FLIP' ? 'FLIP' : 'CLASSIC';

        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            mode: selectedMode,
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentSide: 'light', // 'light' or 'dark'
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
                room.deck = room.mode === 'FLIP' ? createFlipDeck() : createClassicDeck(); 
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
        room.deck = room.mode === 'FLIP' ? createFlipDeck() : createClassicDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0; 
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        room.pendingDrawAction = null;
        room.currentSide = 'light'; // Her zaman light başlar
        
        room.players.forEach(p => { 
            p.hand = room.deck.splice(0, 7); 
            p.cardCount = 7;
            p.hasUno = false;
        });

        // İlk Kart
        let first;
        // Flip modunda Wild kartla başlanmaz, sayı gelene kadar çek
        do {
            first = room.deck.pop();
            const face = getCardFace(first, room);
            if (face.color === 'black') {
                room.deck.unshift(first);
                room.deck = shuffle(room.deck);
                first = null;
            }
        } while (!first);
        
        room.discardPile.push(first);
        const face = getCardFace(first, room);
        room.currentColor = face.color;

        // Başlangıç Action Etkileri (Classic/Flip Light Side)
        if (face.value === 'skip') {
            addLog(room, "Başlangıçta Engel! İlk oyuncu atlandı.");
            advanceTurn(room);
        } else if (face.value === 'reverse') {
            room.direction *= -1;
            addLog(room, "Başlangıçta Yön Değişti!");
            if (room.players.length === 2) advanceTurn(room); 
            else room.turnIndex = room.players.length - 1;
        } else if (face.value === 'draw2' || face.value === 'draw1') {
            const firstPlayer = room.players[room.turnIndex];
            const count = face.value === 'draw2' ? 2 : 1;
            addLog(room, `Başlangıçta +${count}! ${firstPlayer.nickname} kart çekiyor.`);
            drawCards(room, firstPlayer, count);
            advanceTurn(room);
        }
        
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
        
        if(!ensureDeck(room)) return;
        let drawnCard = room.deck.pop();

        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        // Kontrol: Oynanabilir mi?
        const topCard = room.discardPile[room.discardPile.length - 1];
        const topFace = getCardFace(topCard, room);
        const drawnFace = getCardFace(drawnCard, room);

        let isPlayable = false;
        if (drawnFace.color === 'black') isPlayable = true;
        else if (room.currentColor && drawnFace.color === room.currentColor) isPlayable = true;
        else if (drawnFace.value === topFace.value) isPlayable = true;

        if (isPlayable) {
            room.pendingDrawAction = { playerId: player.id, cardId: drawnCard.id };
            socket.emit('drawDecisionRequired', { 
                card: drawnFace, 
                message: "Oynanabilir bir kart çektin! Oynamak ister misin?",
                originalCardObj: drawnCard // Client might need full obj logic (optional)
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
            const face = getCardFace(card, room);

            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColor = room.currentColor;
            room.currentColor = (face.color === 'black') ? chosenColor : face.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} çektiği kartı oynadı: ${formatCardName(face)}`);
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
        if (!player.hand[cardIndex]) return;

        const card = player.hand[cardIndex];
        const face = getCardFace(card, room);
        
        const topCard = room.discardPile[room.discardPile.length - 1];
        const topFace = getCardFace(topCard, room);
        
        let isValid = false;
        if (face.color === 'black') isValid = true;
        else if (face.color === room.currentColor) isValid = true;
        else if (face.value === topFace.value) isValid = true;
        
        // Flip sonrası renk değişimi yoksa ve black değilse her şey atılabilir mi? Hayır.
        
        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (face.color === 'black') ? chosenColor : face.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(face)}`);
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
            // Blöf kontrolünde o anki geçerli kartların Light/Dark yüzüne bakılır
            // Wild4 atıldığı zamanki taraf geçerli olmalıdır. Wild4 atıldığında taraf değişmez.
            const hasColor = attacker.hand.some(c => {
                const f = getCardFace(c, room);
                return f.color === oldColor && f.color !== 'black';
            });
            
            if (hasColor) {
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yapmıştı! (Ceza: 4 Kart)`);
                drawCards(room, attacker, 4);
                // Sıra mağdurda kalmalı mı yoksa oynamadan geçmeli mi? 
                // Resmi kural: Blöf yapan ceza yer, sıradaki oyuncu oynamaz (draw4 etkisi iptal mi? Hayır sadece çekmez).
                // Basitlik için: Attacker ceza yer, oyun devam eder (victim çekmez ve oynar).
                // Ama Wild4 kartı yerde kalır, renk seçilmiş durumdadır.
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
        room.currentSide = 'light';
        
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

function handleCardEffect(room, card, player, oldColorForChallenge) {
    const face = getCardFace(card, room);
    let skipNext = false;
    let nextPlayer = getNextPlayer(room);

    // EFEKTLER
    if (face.value === 'flip') {
        room.currentSide = (room.currentSide === 'light') ? 'dark' : 'light';
        addLog(room, `🌀 ORTAM DEĞİŞTİ! Şimdi ${room.currentSide.toUpperCase()} tarafındayız!`);
        
        // Discard pile üstündeki kartın rengi değişir, current color'ı güncelle
        const topCard = room.discardPile[room.discardPile.length-1];
        const newTopFace = getCardFace(topCard, room);
        
        // Eğer çevrildiğinde üstteki kart Wild ise ve renk atanmamışsa?
        // Oyun akışında discard'a atılan wild zaten renk almış olur (room.currentColor).
        // Ancak Flip kartının kendisi renkli olduğu için sorun yok.
        // Sadece current color Flip kartının yeni yüzündeki renge döner.
        if(newTopFace.color !== 'black') room.currentColor = newTopFace.color;
        
        // Flip kartının Dark yüzü de bir aksiyon olabilir mi? 
        // UNO Flip'te Flip kartının arkası da Flip kartıdır. Renk değişir sadece.
    }

    if (face.value === 'skip') { 
        skipNext = true; 
        addLog(room, "Sıra atladı!"); 
    } 
    else if (face.value === 'skip_all') {
        // Herkesi atla = Sıra tekrar bana gelir
        addLog(room, "⛔ HERKES ATLANIYOR! Sıra tekrar sende.");
        // Turn index değişmez, timer resetlenir
        startTurnTimer(room);
        broadcastGameState(room.id);
        return; // advanceTurn çağırmadan çık
    }
    else if (face.value === 'reverse') {
        room.direction *= -1;
        addLog(room, "Yön değişti!");
        if (room.players.length === 2) { skipNext = true; } 
    }
    else if (face.value === 'draw1') { // Classic/Flip Light Draw 1
        drawCards(room, nextPlayer, 1);
        addLog(room, `${nextPlayer.nickname} +1 yedi!`);
        skipNext = true;
    }
    else if (face.value === 'draw2') { // Classic Draw 2 / Flip Light Draw 2 (Wild)
        // Flip modunda Draw 2 aslında bir Wild karttır (Wild Draw 2)
        // Classic modunda renklidir.
        // getCardFace type bilgisini veriyor.
        if(room.mode === 'FLIP') {
             // Flip modunda Wild Draw 2, renk seçildi, şimdi draw.
             drawCards(room, nextPlayer, 2);
             addLog(room, `${nextPlayer.nickname} +2 yedi!`);
             skipNext = true;
        } else {
             // Classic
             drawCards(room, nextPlayer, 2);
             addLog(room, `${nextPlayer.nickname} +2 yedi!`);
             skipNext = true;
        }
    }
    else if (face.value === 'draw5') { // Flip Dark Side Draw 5
        drawCards(room, nextPlayer, 5);
        addLog(room, `${nextPlayer.nickname} +5 yedi!`);
        skipNext = true;
    }
    else if (face.value === 'wild4') { // Classic Wild Draw 4
        room.pendingChallenge = { 
            attackerId: player.id, 
            victimId: nextPlayer.id, 
            oldColor: oldColorForChallenge 
        };
        io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
        broadcastGameState(room.id);
        return; 
    }
    else if (face.value === 'wild_draw_color') { // Flip Dark Side Wild Draw Color
        // Renk seçildi (room.currentColor güncellendi handleDrawDecision/playCard ile)
        // Mağdur, seçilen renkten bulana kadar çeker.
        addLog(room, `${nextPlayer.nickname}, ${room.currentColor} bulana kadar çekiyor!`);
        
        let drawnCount = 0;
        let drawnCardsList = [];
        let found = false;
        
        // Sonsuz döngü koruması (maksimum 20 kart diyelim veya deste bitene kadar)
        // Deste bitince reshuffle yapılır ensureDeck ile.
        while(!found) {
            if(!ensureDeck(room)) break; // Kart kalmadı
            let c = room.deck.pop();
            nextPlayer.hand.push(c);
            drawnCount++;
            
            const f = getCardFace(c, room);
            if(f.color === room.currentColor) {
                found = true;
            }
            if(drawnCount > 30) break; // Güvenlik
        }
        
        addLog(room, `${nextPlayer.nickname} toplam ${drawnCount} kart çekti.`);
        skipNext = true;
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
                const f = getCardFace(c, room);
                roundScore += (f ? f.score : 0);
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

function ensureDeck(room) {
    if(room.deck.length === 0) {
        if(room.discardPile.length > 1) {
            const top = room.discardPile.pop();
            room.deck = shuffle(room.discardPile);
            room.discardPile = [top];
            addLog(room, "Deste bitti, ıskarta karıştırıldı.");
        } else {
            addLog(room, "Deste ve ıskarta bitti! Oyun kilitlendi.");
            return false;
        }
    }
    return true;
}

function drawCards(room, player, count) {
    for(let i=0; i<count; i++) {
        if(!ensureDeck(room)) break;
        if(room.deck.length > 0) {
            player.hand.push(room.deck.pop());
        }
    }
}

function advanceTurn(room) {
    room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
}

function getNextPlayer(room) {
    const idx = (room.turnIndex + room.direction + room.players.length) % room.players.length;
    return room.players[idx];
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

function formatCardName(face) {
    if(!face) return '???';
    if(face.color === 'black') return face.value === 'wild' ? 'Joker' : (face.value==='wild4' ? '+4 Joker' : 'Renk Çektirici');
    return `${face.color.toUpperCase()} ${face.value}`;
}

function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;

    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            // Client'a sadece geçerli yüzü göndererek kafa karışıklığını önle
            // Ama client animasyon için belki kart ID'sine ihtiyaç duyar.
            // Client tarafında "render" fonksiyonu face'i alacak.
            // MyHand objesini mapleyelim:
            const clientHand = p.hand.map(c => ({
                id: c.id,
                ...getCardFace(c, room)
            }));
            
            const topCard = room.discardPile[room.discardPile.length-1];

            socket.emit('roomUpdate', {
                roomId: room.id,
                mode: room.mode,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                currentSide: room.currentSide,
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar,
                    cardCount: pl.hand.length,
                    hasUno: room.unoCallers.has(pl.id),
                    totalScore: pl.totalScore || 0
                })),
                myHand: clientHand,
                topCard: topCard ? getCardFace(topCard, room) : null,
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
server.listen(PORT, () => console.log('UNO Legend Server Aktif!'));
