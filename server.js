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

// --- DESTE OLUŞTURMA MANTIĞI ---
function createDeck(mode) {
    if (mode === 'UNO_X') {
        return createUnoXDeck();
    } else {
        return createClassicDeck();
    }
}

function createClassicDeck() {
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

// UNO X (FLIP) DESTESİ
function createUnoXDeck() {
    const lightColors = ['red', 'blue', 'green', 'yellow'];
    const darkColors = ['orange', 'pink', 'teal', 'purple'];
    const deck = [];

    // Kartları oluştururken her iki yüzü de tanımlıyoruz
    // Basitlik adına: Kartların light ve dark karşılıklarını rastgele değil, sistematik eşleştiriyoruz.
    
    for (let c = 0; c < 4; c++) {
        const lColor = lightColors[c];
        const dColor = darkColors[c];

        // Sayı Kartları 1-9
        for (let i = 1; i <= 9; i++) {
            // 2 set
            for(let k=0; k<2; k++) {
                deck.push({
                    id: Math.random().toString(36),
                    sides: {
                        light: { color: lColor, value: i.toString(), type: 'number', score: i },
                        dark: { color: dColor, value: i.toString(), type: 'number', score: i } // Dark taraf da sayı olabilir
                    }
                });
            }
        }

        // Aksiyonlar: Light (Draw1, Skip, Reverse, Flip) vs Dark (Draw5, SkipEveryone, Reverse, Flip)
        ['draw1', 'skip', 'reverse', 'flip'].forEach(val => {
            for(let k=0; k<2; k++) {
                let darkVal = val;
                if(val === 'draw1') darkVal = 'draw5'; // Light +1 -> Dark +5
                if(val === 'skip') darkVal = 'skip_all'; // Light Skip -> Dark Skip Everyone
                
                deck.push({
                    id: Math.random().toString(36),
                    sides: {
                        light: { color: lColor, value: val, type: 'action', score: 20 },
                        dark: { color: dColor, value: darkVal, type: 'action', score: (val==='flip'?20:40) }
                    }
                });
            }
        });
    }

    // Jokerler
    for(let i=0; i<4; i++) {
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'wild', type: 'wild', score: 40 },
                dark: { color: 'black', value: 'wild_color', type: 'wild', score: 60 } // Wild Draw Color
            }
        });
        deck.push({
            id: Math.random().toString(36),
            sides: {
                light: { color: 'black', value: 'wild2', type: 'wild', score: 50 }, // Wild Draw 2
                dark: { color: 'black', value: 'wild', type: 'wild', score: 40 }
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
            count: r.players.length, 
            status: r.gameState,
            mode: r.mode // Mod bilgisini gönder
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
            mode: mode || 'CLASSIC', // Varsayılan Klasik
            players: [],
            gameState: 'LOBBY',
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            activeSide: 'light', // UNO X için taraf takibi
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
                id: joinerId, nickname, avatar, hand: [], score: 0, totalScore: 0
            };
            
            if (room.deck.length < 7) { room.deck = createDeck(room.mode); }
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
        room.deck = createDeck(room.mode);
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0;
        room.activeSide = 'light'; // Her zaman aydınlık başlar
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
            // UNO X modunda, eğer ilk kart 'wild4' veya benzeri ise geri koy (Basitleştirilmiş kural)
            if(room.mode === 'UNO_X' && getCardFace(first, 'light').value.includes('wild')) {
                 room.deck.push(first);
                 room.deck = shuffle(room.deck);
                 first = null;
            } else if (first.value === 'wild4') { // Klasik +4 kontrolü
                room.deck.push(first);
                room.deck = shuffle(room.deck);
                first = null;
            }
        } while (!first);
        
        room.discardPile.push(first);
        
        const firstFace = getCardFace(first, room.activeSide);
        if (firstFace.color === 'black') { 
            room.currentColor = null; 
            addLog(room, "Joker açıldı! Renk seçilmeli.");
        } else {
            room.currentColor = firstFace.color;
        }

        addLog(room, "Oyun Başladı!");
        startTurnTimer(room);
        broadcastGameState(roomId);
    });

    // --- KART YARDIMCISI: MODA GÖRE KART YÜZÜNÜ AL ---
    function getCardFace(card, side) {
        if (!card.sides) return card; // Klasik kart
        return card.sides[side]; // Uno X kartı (light/dark)
    }

    socket.on('drawCard', () => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);
        
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.pendingDrawAction) return; 

        resetTurnTimer(room);
        
        let drawnCard = null;
        if(room.deck.length === 0) {
             if(room.discardPile.length > 1) {
                 const top = room.discardPile.pop();
                 room.deck = shuffle(room.discardPile);
                 room.discardPile = [top];
             } else {
                 room.deck = createDeck(room.mode); // Yedek plan
             }
        }
        if(room.deck.length > 0) drawnCard = room.deck.pop();
        else return;

        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        // Kontrol: Oynanabilir mi?
        const topCardRaw = room.discardPile[room.discardPile.length - 1];
        const topFace = getCardFace(topCardRaw, room.activeSide);
        const drawnFace = getCardFace(drawnCard, room.activeSide);

        let isPlayable = false;
        if (drawnFace.color === 'black') isPlayable = true;
        else if (room.currentColor && drawnFace.color === room.currentColor) isPlayable = true;
        else if (drawnFace.value === topFace.value) isPlayable = true;

        if (isPlayable) {
            room.pendingDrawAction = { playerId: player.id, cardId: drawnCard.id };
            socket.emit('drawDecisionRequired', { 
                card: drawnFace, // Sadece görünen yüzü gönder
                message: "Oynanabilir kart! Oynamak ister misin?" 
            });
            broadcastGameState(roomId);
            startTurnTimer(room);
        } else {
            addLog(room, "Oynanamaz. Sıra geçiyor.");
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
            
            const cardFace = getCardFace(card, room.activeSide);
            const oldColor = room.currentColor;
            room.currentColor = (cardFace.color === 'black') ? chosenColor : cardFace.color;
            
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} çektiği kartı oynadı: ${formatCardName(cardFace)}`);
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
        const cardFace = getCardFace(card, room.activeSide); // Aktif yüze bak
        
        const topCardRaw = room.discardPile[room.discardPile.length - 1];
        const topFace = getCardFace(topCardRaw, room.activeSide);

        let isValid = false;
        if (cardFace.color === 'black') isValid = true;
        else if (cardFace.color === room.currentColor) isValid = true;
        else if (cardFace.value === topFace.value) isValid = true;
        if (room.currentColor === null && cardFace.color !== 'black') isValid = true;

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (cardFace.color === 'black') ? chosenColor : cardFace.color;

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(cardFace)}`);
            handleCardEffect(room, card, player, oldColorForChallenge);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

    // --- UNO X İÇİN ETKİ YÖNETİMİ ---
    function handleCardEffect(room, card, player, oldColorForChallenge) {
        const face = getCardFace(card, room.activeSide);
        let skipNext = false;

        // FLIP KARTI (UNO X)
        if (face.value === 'flip') {
            room.activeSide = (room.activeSide === 'light') ? 'dark' : 'light';
            addLog(room, `🌀 DÜNYA TERSİNE DÖNDÜ! Şimdi ${room.activeSide === 'light' ? 'AYDINLIK' : 'KARANLIK'} taraf!`);
            
            // Desteleri ters çevir (Görsel ve mantıksal)
            room.deck.reverse(); 
            room.discardPile.reverse();
            
            // Renk güncelle: Çevrilen kartın yeni yüzünün rengi geçerli olur
            const newTop = room.discardPile[room.discardPile.length-1];
            const newFace = getCardFace(newTop, room.activeSide);
            
            if(newFace.color === 'black') {
                // Eğer flip sonrası wild gelirse, önceki renk korunur veya rastgele atanır (Basitlik: Koru)
                // room.currentColor = oldColorForChallenge; 
            } else {
                room.currentColor = newFace.color;
            }
        }

        if (face.value === 'skip') { skipNext = true; addLog(room, "Sıra atladı!"); } 
        else if (face.value === 'skip_all') { // Dark Side
            addLog(room, "🚫 HERKESİ GEÇ! Sıra yine sende.");
            // Turn index değişmez, sıra aynı kişide kalır.
            // Ancak advanceTurn çağrılmamalı.
            if (player.hand.length === 0) { finishGame(room, player); return; }
            broadcastGameState(room.id);
            startTurnTimer(room);
            return;
        }
        else if (face.value === 'reverse') {
            room.direction *= -1;
            addLog(room, "Yön değişti!");
            if (room.players.length === 2) { skipNext = true; } 
        }
        else if (face.value === 'draw1') { // UNO X Light +1
            const next = getNextPlayer(room);
            drawCards(room, next, 1);
            addLog(room, `${next.nickname} +1 yedi!`);
            skipNext = true;
        }
        else if (face.value === 'draw2') { // Classic +2
            const next = getNextPlayer(room);
            drawCards(room, next, 2);
            addLog(room, `${next.nickname} +2 yedi!`);
            skipNext = true;
        }
        else if (face.value === 'draw5') { // UNO X Dark +5
            const next = getNextPlayer(room);
            drawCards(room, next, 5);
            addLog(room, `${next.nickname} +5 yedi! (Karanlık Tarafın Gücü)`);
            skipNext = true;
        }
        else if (face.value === 'wild4' || face.value === 'wild2') {
            const count = (face.value === 'wild4') ? 4 : 2;
            const nextIdx = getNextPlayerIndex(room);
            const nextPlayer = room.players[nextIdx];
            
            // Challenge mekanizmasını şimdilik basitleştirip direkt çektiriyoruz (UNO X karmaşasını azaltmak için)
            // İstersen challenge eklenebilir ama UNO X zaten çok karmaşık.
            drawCards(room, nextPlayer, count);
            addLog(room, `${nextPlayer.nickname} +${count} yedi!`);
            skipNext = true;
        }
        else if (face.value === 'wild_color') { // UNO X Dark - Renk Çekene Kadar
            const next = getNextPlayer(room);
            addLog(room, `🎨 ${next.nickname} renk tutana kadar kart çekecek!`);
            // Bu mantık serverda anlık yapılır
            let drawnCount = 0;
            while(true) {
                if(room.deck.length === 0) {
                    if(room.discardPile.length > 1) {
                        const top = room.discardPile.pop();
                        room.deck = shuffle(room.discardPile);
                        room.discardPile = [top];
                    } else { break; } // Kart yok
                }
                const c = room.deck.pop();
                next.hand.push(c);
                drawnCount++;
                const cFace = getCardFace(c, room.activeSide);
                if(cFace.color === room.currentColor) break; // Renk tuttu
                if(drawnCount > 20) break; // Güvenlik freni
            }
            addLog(room, `${next.nickname} toplam ${drawnCount} kart çekti!`);
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

    socket.on('chatMessage', ({ message, targetId }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const sender = room.players.find(p => p.id === socket.id);
        const chatData = { sender: sender.nickname, avatar: sender.avatar, msg: message, type: 'public', time: '' };
        if(targetId === 'all') io.to(roomId).emit('chatBroadcast', chatData);
    });

    socket.on('challengeDecision', ({ decision }) => { /* ... Eski kod aynı ... */ });
    
    socket.on('returnToLobby', () => {
        const roomId = getPlayerRoomId(socket.id);
        if(!roomId) return;
        const room = rooms.get(roomId);
        room.gameState = 'LOBBY';
        room.players.forEach(p => { p.hand = []; p.cardCount = 0; p.hasUno = false; });
        room.deck = []; room.discardPile = []; room.activeSide = 'light';
        io.to(roomId).emit('gameReset', { roomId });
        broadcastGameState(roomId);
    });

    socket.on('disconnect', () => { /* ... Eski kod aynı ... */ });
});

// Yardımcılar
function startTurnTimer(room) { /* ... Eski kod aynı ... */ }
function resetTurnTimer(room) { if(room.timer) clearTimeout(room.timer); }
function finishGame(room, winner) { /* ... Eski kod aynı ... */ }
function getPlayerRoomId(socketId) {
    for (const [id, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return id;
    }
    return null;
}
function addLog(room, msg) { /* ... Eski kod aynı ... */ }
function formatCardName(c) {
    if(c.color === 'black') {
        if(c.value === 'wild_color') return 'Joker Renk Çek';
        return 'Joker';
    }
    return `${c.color.toUpperCase()} ${c.value}`;
}
function broadcastGameState(roomId) {
    const room = rooms.get(roomId);
    if(!room) return;
    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (socket) {
            // İSTEMCİYE KART GÖNDERİRKEN DÖNÜŞTÜR
            // Oyuncu kendi elinin AKTİF yüzünü görür.
            const visibleHand = p.hand.map(c => getCardFace(c, room.activeSide));
            // Yerden görünen kart da aktif yüzdür
            const visibleTop = getCardFace(room.discardPile[room.discardPile.length-1], room.activeSide);

            socket.emit('roomUpdate', {
                roomId: room.id,
                isHost: (p.id === room.hostId),
                gameState: room.gameState,
                mode: room.mode,
                activeSide: room.activeSide, // Istemci renk temasını buna göre ayarlayacak
                playerCount: room.players.length,
                players: room.players.map(pl => ({ 
                    id: pl.id, nickname: pl.nickname, avatar: pl.avatar,
                    cardCount: pl.hand.length, hasUno: room.unoCallers.has(pl.id), totalScore: pl.totalScore || 0
                })),
                myHand: visibleHand,
                topCard: visibleTop,
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
