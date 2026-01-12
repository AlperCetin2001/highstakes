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
    
    const queryName = socket.handshake.query.nickname;
    const queryAvatar = socket.handshake.query.avatar;
    if(queryName) {
        socket.data.nickname = queryName;
        socket.data.avatar = queryAvatar || '👤';
    }

    // ODA LİSTESİNDE MOD BİLGİSİ GÖNDERİLİYOR
    socket.on('getRooms', () => {
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, 
            name: r.name, 
            count: r.players.length, 
            status: r.gameState,
            mode: r.mode || 'CLASSIC' // Mod bilgisi
        }));
        socket.emit('roomList', list);
    });

    // ODA OLUŞTURURKEN MOD SEÇİMİ
    socket.on('createRoom', ({ nickname, avatar, mode }) => {
        socket.data.nickname = nickname;
        socket.data.avatar = avatar;

        const roomId = generateRoomId();
        const selectedMode = (mode === 'UNO_X') ? 'UNO_X' : 'CLASSIC';

        const room = {
            id: roomId,
            name: `${nickname}'in Odası`,
            hostId: socket.id,
            players: [],
            gameState: 'LOBBY',
            mode: selectedMode, // OYUN MODU KAYDEDİLDİ
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            pendingDrawAction: null,
            drawStack: 0, // UNO X için birikmiş ceza
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
            
            if (room.deck.length < 7) { room.deck = createDeck(); }
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
        room.deck = createDeck();
        room.discardPile = [];
        room.direction = 1;
        room.turnIndex = 0;
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

        let first;
        do {
            first = room.deck.pop();
            if (first.value === 'wild4') {
                room.deck.push(first);
                room.deck = shuffle(room.deck);
            }
        } while (first.value === 'wild4');
        
        room.discardPile.push(first);
        
        if (first.color === 'black') { 
            room.currentColor = null; 
            addLog(room, "Joker açıldı! İlk oyuncu rengi belirliyor.");
        } else {
            room.currentColor = first.color;
        }

        if (first.value === 'skip') {
            addLog(room, "Başlangıçta Engel! İlk oyuncu atlandı.");
            advanceTurn(room);
        } else if (first.value === 'reverse') {
            room.direction *= -1;
            addLog(room, "Başlangıçta Yön Değişti!");
            if (room.players.length === 2) { advanceTurn(room); } 
            else { room.turnIndex = room.players.length - 1; }
        } else if (first.value === 'draw2') {
            // UNO X ise stackle, Klasik ise çektir
            if (room.mode === 'UNO_X') {
                room.drawStack += 2;
                addLog(room, `Başlangıçta +2! Ceza Yığını: ${room.drawStack}`);
                // Sıra geçmez, ilk oyuncu karşılamalı veya çekmeli
            } else {
                const firstPlayer = room.players[room.turnIndex];
                addLog(room, `Başlangıçta +2! ${firstPlayer.nickname} 2 kart çekiyor.`);
                drawCards(room, firstPlayer, 2);
                advanceTurn(room);
            }
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

        // --- UNO X: BİRİKMİŞ CEZA VARSA HEPSİNİ ÇEK VE TURU BİTİR ---
        if (room.mode === 'UNO_X' && room.drawStack > 0) {
            addLog(room, `🚫 ${player.nickname} cezayı karşılayamadı! ${room.drawStack} kart çekti.`);
            drawCards(room, player, room.drawStack);
            room.drawStack = 0;
            advanceTurn(room);
            broadcastGameState(roomId);
            startTurnTimer(room);
            return;
        }
        
        // Normal Kart Çekme
        let drawnCard = null;
        if(room.deck.length === 0) {
             if(room.discardPile.length > 1) {
                 const top = room.discardPile.pop();
                 room.deck = shuffle(room.discardPile);
                 room.discardPile = [top];
             } else {
                 // Kart kalmadıysa yapacak bir şey yok
                 advanceTurn(room);
                 broadcastGameState(roomId);
                 return;
             }
        }
        if(room.deck.length > 0) drawnCard = room.deck.pop();
        else return;

        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        // Klasik Modda Karar Mekanizması, UNO X'te de aynı
        const top = room.discardPile[room.discardPile.length - 1];
        let isPlayable = false;
        
        // UNO X'te eğer yerdeki kart +2 ise ve bizde +2 yoksa, çektiğimiz kart +2 ise oynanabilir
        // Basit kontrol:
        if (drawnCard.color === 'black') isPlayable = true;
        else if (room.currentColor && drawnCard.color === room.currentColor) isPlayable = true;
        else if (drawnCard.value === top.value) isPlayable = true;

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
            
            const oldColor = room.currentColor;
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;
            
            // --- UNO X: OTOMATİK CEZA ---
            if (room.mode === 'UNO_X' && player.hand.length === 1 && !room.unoCallers.has(player.id)) {
                addLog(room, `⚡ UNO X: ${player.nickname} UNO demeyi unuttu! OTO-CEZA (+2)`);
                drawCards(room, player, 2);
            }

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} çektiği kartı oynadı: ${formatCardName(card)}`);
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

    // --- ÇOKLU KART OYNAMA (SADECE UNO X) ---
    socket.on('playCards', ({ cardIndices, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        
        // MOD KONTROLÜ
        if (room.mode !== 'UNO_X') {
            return socket.emit('error', 'Çoklu kart atma sadece UNO X modunda aktiftir!');
        }

        const player = room.players.find(p => p.id === socket.id);
        if (room.players[room.turnIndex].id !== socket.id) return;
        if (room.drawStack > 0) return socket.emit('error', 'Cezalı durumda kombo yapamazsın!');

        cardIndices.sort((a, b) => b - a);
        const cardsToPlay = cardIndices.map(idx => player.hand[idx]);
        if(cardsToPlay.length < 2) return;

        // Kural: Hepsi aynı sayı/değer olmalı
        const firstVal = cardsToPlay[0].value;
        const allSame = cardsToPlay.every(c => c.value === firstVal);
        if (!allSame) return socket.emit('error', 'Sadece aynı değere sahip kartları kombo yapabilirsin!');

        // Kural: İlk kart yere uymalı
        const top = room.discardPile[room.discardPile.length - 1];
        // En az bir kartın yere uyması yeterli mantığı ile:
        // Ancak genelde en alttaki kartın uyması beklenir.
        // Basitleştirilmiş: Herhangi biri uyuyorsa geçerli sayıp o kartı en alta koymuş gibi işlem yapabiliriz
        // Veya daha katı: İlk seçilen kart uymalı.
        // Bizim UI tek tek seçtirmiyor, toplu gönderiyor.
        // O yüzden: "En az biri mevcut renge veya sayıya uymalı"
        const validStarter = cardsToPlay.find(c => 
            c.color === room.currentColor || c.value === top.value || c.color === 'black'
        );

        if (!validStarter) return socket.emit('error', 'Hiçbir kart yere uymuyor!');

        resetTurnTimer(room);
        
        // Kartları elden sil
        cardIndices.forEach(idx => player.hand.splice(idx, 1));
        
        // Yere at (Sırayla)
        cardsToPlay.forEach(c => room.discardPile.push(c));
        
        // Son kartın etkisi geçerlidir
        const lastPlayed = cardsToPlay[0]; // (Ters sıralandığı için veya düz, farketmez, hepsi aynı değer)
        // Renk değişimi son karta göre
        room.currentColor = (lastPlayed.color === 'black') ? chosenColor : lastPlayed.color;

        if (player.hand.length === 1 && !room.unoCallers.has(player.id)) {
             addLog(room, `⚡ UNO X: ${player.nickname} UNO unuttu! (+2)`);
             drawCards(room, player, 2);
        }
        if (player.hand.length !== 1) room.unoCallers.delete(player.id);

        addLog(room, `🔥 KOMBO! ${player.nickname} ${cardsToPlay.length} tane ${lastPlayed.value} attı!`);
        
        // Efekti uygula (Örn: 2 tane +2 attıysa, +4 olarak gitmeli mi? UNO X kurallarında stacklenir)
        // UNO X'te kartın etkisi bir kere tetiklenir ama eğer draw kartıysa stack artmalı.
        // Basit UNO X kuralı: Son kartın efekti geçerli.
        // Ancak Draw kartları kombo yapılırsa stack toplanmalı.
        
        if (lastPlayed.value === 'draw2') {
            room.drawStack += (2 * cardsToPlay.length);
            addLog(room, `Yığın Yükseldi! Toplam: +${room.drawStack}`);
            advanceTurn(room);
        } else if (lastPlayed.value === 'wild4') {
             // Wild 4 kombo yapılırsa... Challenge riskli olur. Basit tutalım:
             room.pendingChallenge = { 
                attackerId: player.id, 
                victimId: getNextPlayer(room).id, 
                oldColor: room.currentColor 
            };
            // Stack eklemiyor normalde wild4, ama UNO X stackler.
            // Stack implementation for Wild4 is complex with challenge.
            // Let's assume standard effect for combo non-draw cards.
            handleCardEffect(room, lastPlayed, player, null);
        } else {
            handleCardEffect(room, lastPlayed, player, null);
        }
        
        broadcastGameState(roomId);
        startTurnTimer(room);
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
        const top = room.discardPile[room.discardPile.length - 1];
        
        // --- UNO X: CEZA YIĞINI VARSA ---
        if (room.mode === 'UNO_X' && room.drawStack > 0) {
            // Sadece +2 veya +4 atılabilir (Renge bakılmaksızın stacklenebilir mi? Genelde evet)
            // Kural: +2 üzerine +2, +4 üzerine +4.
            // Bazı varyasyonlarda +2 üstüne +4 atılır ama tersi olmaz.
            // Bizim Kural: Draw kartları birbiri üstüne binebilir.
            let canStack = false;
            if (card.value === 'draw2') canStack = true;
            if (card.value === 'wild4') canStack = true;

            if (!canStack) {
                return socket.emit('error', `Yerde +${room.drawStack} ceza var! Sadece +2 veya +4 atabilirsin.`);
            }
        }

        let isValid = false;
        if (card.color === 'black') isValid = true;
        else if (card.color === room.currentColor) isValid = true;
        else if (card.value === top.value) isValid = true;
        
        if (room.currentColor === null && card.color !== 'black') isValid = true; 

        // Stack modunda validasyon (Zaten yukarıda stack check yaptık, burası normal renk kontrolü)
        // Stack durumunda renk kuralı esner mi? Genelde +2 kuralı renge bakmaz stacklerken.
        if (room.mode === 'UNO_X' && room.drawStack > 0 && (card.value === 'draw2' || card.value === 'wild4')) {
            isValid = true; // Stacklerken renk önemsizleşir
        }

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            // --- UNO X: OTOMATİK CEZA ---
            if (room.mode === 'UNO_X' && player.hand.length === 1 && !room.unoCallers.has(player.id)) {
                addLog(room, `⚡ UNO X: ${player.nickname} UNO unuttu! (+2)`);
                drawCards(room, player, 2);
            }
            // Klasik modda otomatik ceza yok, catch butonu var.

            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(card)}`);
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
        
        // UNO X'te bu buton işlevsizdir çünkü ceza otomatiktir.
        if (room.mode === 'UNO_X') return;

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
            const amount = (room.mode === 'UNO_X' && room.drawStack > 0) ? room.drawStack : 4;
            addLog(room, `${victim.nickname} kabul etti. +${amount}`);
            drawCards(room, victim, amount);
            room.drawStack = 0;
            advanceTurn(room); 
        } else {
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                // Yakalandı
                addLog(room, `⚖️ BLÖF! ${attacker.nickname} yakalandı!`);
                // UNO X ise stack ona geri döner mi? Genelde hayır, standart ceza.
                // Klasik: +4. 
                drawCards(room, attacker, 4);
                // Sıra mağdurda kalır ama ceza yemez
                // Kural gereği sıra mağdurdan bir sonrakine geçer mi? Hayır, mağdur oynamaz.
                // Basitlik için sıra mağdura geçsin ama ceza yemesin.
                // Wild kartın rengi değişmişti zaten.
            } else {
                // Temiz
                const amount = (room.mode === 'UNO_X' && room.drawStack > 0) ? room.drawStack + 2 : 6;
                addLog(room, `⚖️ TEMİZ! ${victim.nickname} +${amount} çekiyor!`);
                drawCards(room, victim, amount);
                room.drawStack = 0;
            }
            advanceTurn(room);
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
        room.drawStack = 0;
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
        if (room.mode === 'UNO_X') {
            room.drawStack += 2;
            addLog(room, `Yığın Arttı! (+${room.drawStack})`);
            // Sıra geçiyor, sonraki oyuncu karşılamalı
        } else {
            const next = getNextPlayer(room);
            drawCards(room, next, 2);
            addLog(room, `${next.nickname} +2 yedi!`);
            skipNext = true;
        }
    }
    else if (card.value === 'wild4') {
        if (room.mode === 'UNO_X') {
            room.drawStack += 4;
            addLog(room, `Yığın Arttı! (+${room.drawStack})`);
            // UNO X'te challenge opsiyonel veya devre dışı olabilir hızlı oyun için
            // Ancak kurala sadık kalalım: Challenge yine de yapılabilir.
            const nextPlayer = room.players[getNextPlayerIndex(room)];
            room.pendingChallenge = { 
                attackerId: player.id, 
                victimId: nextPlayer.id, 
                oldColor: oldColorForChallenge 
            };
            io.to(nextPlayer.id).emit('challengePrompt', { attacker: player.nickname });
            broadcastGameState(room.id);
            return;
        } else {
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

        // Süre bitince:
        if (room.pendingDrawAction) {
            room.pendingDrawAction = null;
            advanceTurn(room);
        } else {
            // Eğer UNO X ve yığın varsa hepsini çeker
            if (room.mode === 'UNO_X' && room.drawStack > 0) {
                drawCards(room, currentPlayer, room.drawStack);
                room.drawStack = 0;
            } else {
                drawCards(room, currentPlayer, 1);
            }
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
            p.hand.forEach(c => roundScore += c.score);
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
                room.deck = createDeck();
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
                drawStack: room.drawStack || 0, // UNO X için stack bilgisi
                mode: room.mode
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Legend Server Aktif!'));
