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

    socket.on('getRooms', () => {
        // ODA LİSTESİNDE MOD BİLGİSİNİ GÖNDERİYORUZ
        const list = Array.from(rooms.values()).map(r => ({ 
            id: r.id, 
            name: r.name, 
            count: r.players.length, 
            status: r.gameState,
            mode: r.mode // 'CLASSIC' veya 'UNO_X'
        }));
        socket.emit('roomList', list);
    });

    // ODA OLUŞTURURKEN MOD SEÇİMİNİ ALIYORUZ
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
            mode: mode || 'CLASSIC', // Varsayılan Klasik
            deck: [],
            discardPile: [],
            turnIndex: 0,
            direction: 1,
            currentColor: null,
            logs: [],
            unoCallers: new Set(),
            pendingChallenge: null,
            pendingDrawAction: null,
            drawStack: 0, // UNO X: Biriken ceza puanı
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
        room.turnIndex = Math.floor(Math.random() * room.players.length); // Rastgele Başlangıç
        room.unoCallers.clear();
        room.logs = [];
        room.pendingChallenge = null;
        room.pendingDrawAction = null;
        room.drawStack = 0; // Stack sıfırla
        
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

        // Başlangıç Kartı Etkileri
        if (first.value === 'skip') {
            addLog(room, "Başlangıçta Engel! İlk oyuncu atlandı.");
            advanceTurn(room);
        } else if (first.value === 'reverse') {
            room.direction *= -1;
            addLog(room, "Başlangıçta Yön Değişti!");
            if (room.players.length === 2) { advanceTurn(room); } 
            else { room.turnIndex = room.players.length - 1; }
        } else if (first.value === 'draw2') {
            if (room.mode === 'UNO_X') {
                // UNO X: Stack başlar, çekme yok
                room.drawStack += 2;
                addLog(room, `Başlangıç +2! Stack başladı: ${room.drawStack} kart.`);
            } else {
                // KLASİK: Hemen çeker
                const firstPlayer = room.players[room.turnIndex];
                addLog(room, `Başlangıçta +2! ${firstPlayer.nickname} 2 kart çekiyor ve sıra geçiyor.`);
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
        
        // UNO X: STACK VARSA HEPSİNİ ÇEK VE TURU BİTİR
        if (room.mode === 'UNO_X' && room.drawStack > 0) {
            addLog(room, `😞 ${player.nickname} yığılan ${room.drawStack} kartı çekti ve turu kaybetti.`);
            drawCards(room, player, room.drawStack);
            room.drawStack = 0; // Stack sıfırlandı
            advanceTurn(room);
            broadcastGameState(roomId);
            startTurnTimer(room);
            return;
        }

        // NORMAL KART ÇEKME
        let drawnCard = null;
        if(room.deck.length === 0) {
             if(room.discardPile.length > 1) {
                 const top = room.discardPile.pop();
                 room.deck = shuffle(room.discardPile);
                 room.discardPile = [top];
             }
        }
        if(room.deck.length > 0) drawnCard = room.deck.pop();
        else return;

        player.hand.push(drawnCard);
        addLog(room, `${player.nickname} kart çekti.`);

        // Oynanabilir mi kontrolü
        const top = room.discardPile[room.discardPile.length - 1];
        let isPlayable = false;
        
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
            
            // UNO X: Otomatik Ceza Kontrolü (Decision sonrası)
            if (room.mode === 'UNO_X' && player.hand.length === 1 && !room.unoCallers.has(player.id)) {
                addLog(room, `⚡ UNO X KURALI: ${player.nickname} UNO demedi! Otomatik +2 Ceza!`);
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
        
        let isValid = false;
        
        // UNO X: Stacking Varsa Sadece Uyumlu + Kart Atılabilir
        if (room.mode === 'UNO_X' && room.drawStack > 0) {
            if (card.value === 'draw2' || card.value === 'wild4') {
                isValid = true; // +2 veya +4 ile stack devam ettirilebilir
            } else {
                return socket.emit('error', `Yerde ${room.drawStack} ceza kartı var! Sadece +2 veya +4 atabilirsin yada kart çekmelisin!`);
            }
        } else {
            // Normal Kontrol
            if (card.color === 'black') isValid = true;
            else if (card.color === room.currentColor) isValid = true;
            else if (card.value === top.value) isValid = true;
            if (room.currentColor === null && card.color !== 'black') isValid = true;
        }

        if (isValid) {
            resetTurnTimer(room);
            player.hand.splice(cardIndex, 1);
            room.discardPile.push(card);
            
            const oldColorForChallenge = room.currentColor;
            room.currentColor = (card.color === 'black') ? chosenColor : card.color;

            // --- UNO CEZASI ---
            if (room.mode === 'UNO_X') {
                // UNO X: Unuttuysa OTOMATİK ceza
                if (player.hand.length === 1 && !room.unoCallers.has(player.id)) {
                    addLog(room, `⚡ UNO X KURALI: ${player.nickname} UNO demedi! Otomatik +2 Ceza!`);
                    drawCards(room, player, 2);
                }
            } else {
                // KLASİK: Sadece durumu temizle (Rakipler yakalamalı)
            }
            
            if (player.hand.length !== 1) room.unoCallers.delete(player.id);

            addLog(room, `${player.nickname} attı: ${formatCardName(card)}`);
            handleCardEffect(room, card, player, oldColorForChallenge);
        } else {
            socket.emit('error', 'Bu kartı oynayamazsın!');
        }
    });

    // --- UNO X: KOMBO (AYNI SAYI) ---
    // Eğer oyuncu birden fazla kart atıyorsa
    socket.on('playCards', ({ cardIndices, chosenColor }) => {
        const roomId = getPlayerRoomId(socket.id);
        if (!roomId) return;
        const room = rooms.get(roomId);
        const player = room.players.find(p => p.id === socket.id);

        // Kombo sadece UNO X modunda açıktır
        if (room.mode !== 'UNO_X') return socket.emit('error', 'Kombo sadece UNO X modunda!');
        if (room.drawStack > 0) return socket.emit('error', 'Ceza varken kombo yapamazsın!');

        cardIndices.sort((a, b) => b - a); // Sondan başa silmek için
        const cardsToPlay = cardIndices.map(idx => player.hand[idx]);
        const firstCard = cardsToPlay[cardsToPlay.length - 1]; // İlk atılacak kart (validasyon için)
        const top = room.discardPile[room.discardPile.length - 1];

        // Hepsi aynı DEĞERDE mi? (Renk önemli değil UNO X kombosunda)
        const allSameValue = cardsToPlay.every(c => c.value === firstCard.value);
        if (!allSameValue) return socket.emit('error', 'Kombo için kartların sayısı/değeri aynı olmalı!');

        // İlk kart yere uyuyor mu?
        let isFirstValid = (firstCard.color === 'black') || (firstCard.color === room.currentColor) || (firstCard.value === top.value);
        if (!isFirstValid) return socket.emit('error', 'İlk kart yere uymuyor.');

        // Oyna
        resetTurnTimer(room);
        cardIndices.forEach(idx => player.hand.splice(idx, 1));
        cardsToPlay.forEach(c => room.discardPile.push(c));

        // Son kartın etkisi geçerli olur
        const lastPlayed = cardsToPlay[0];
        room.currentColor = (lastPlayed.color === 'black') ? chosenColor : lastPlayed.color;

        // UNO X Otomatik Ceza
        if (player.hand.length === 1 && !room.unoCallers.has(player.id)) {
             addLog(room, `⚡ UNO X: ${player.nickname} UNO demedi! +2 Ceza!`);
             drawCards(room, player, 2);
        }
        if (player.hand.length !== 1) room.unoCallers.delete(player.id);

        addLog(room, `${player.nickname} ${cardsToPlay.length} kartlık KOMBO yaptı!`);
        handleCardEffect(room, lastPlayed, player, null);
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
        
        // UNO X'te bu buton çalışmaz, sistem otomatiktir.
        if(room.mode === 'UNO_X') return socket.emit('error', 'UNO X modunda cezalar otomatiktir!');

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
            // UNO X: Kabul ederse stack'i çeker
            if (room.mode === 'UNO_X') {
                addLog(room, `${victim.nickname} +4'ü kabul etti. Toplam ${room.drawStack} kart çekiyor.`);
                drawCards(room, victim, room.drawStack);
                room.drawStack = 0;
            } else {
                addLog(room, `${victim.nickname} +4'ü kabul etti.`);
                drawCards(room, victim, 4);
            }
            advanceTurn(room); 
        } else {
            // Challenge
            const hasColor = attacker.hand.some(c => c.color === oldColor && c.color !== 'black');
            if (hasColor) {
                // YAKALANDI
                addLog(room, `⚖️ YAKALANDI! ${attacker.nickname} blöf yapmıştı!`);
                if (room.mode === 'UNO_X') {
                    // UNO X: Attacker tüm stack'i çeker
                    drawCards(room, attacker, room.drawStack);
                    room.drawStack = 0;
                } else {
                    drawCards(room, attacker, 4);
                }
                // Sıra mağdurda kalır, oynamaz, geçer (Klasik kural: challenge başarılıysa sıra geçer mi? Evet geçer ama mağdur kart çekmez.)
                // Basitlik için sıra mağdurda kalsın, kart çekmedi.
                // Düzeltme: Mattel kuralına göre blöfçü 4 çeker, sıra mağdura gelmez mi? Hayır sıra devam eder.
                // Biz burada sırayı geçirelim.
                advanceTurn(room); 
            } else {
                // TEMİZ
                if (room.mode === 'UNO_X') {
                    addLog(room, `⚖️ TEMİZ! ${victim.nickname} ekstradan 2 kart daha çekiyor!`);
                    drawCards(room, victim, room.drawStack + 2);
                    room.drawStack = 0;
                } else {
                    addLog(room, `⚖️ TEMİZ! ${victim.nickname} 6 kart çekiyor!`);
                    drawCards(room, victim, 6);
                }
                advanceTurn(room);
            }
        }

        room.pendingChallenge = null;
        broadcastGameState(roomId);
        startTurnTimer(room);
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

// --- OYUN MANTIĞI & EFEKTLER ---

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
            // UNO X: Stack'e ekle, sırayı geçir (Çektirme!)
            room.drawStack += 2;
            addLog(room, `⛓️ STACK! Toplam Ceza: ${room.drawStack} Kart`);
            // Sıra bir sonraki oyuncuya geçer, o oyuncu ya stack yapar ya çeker
        } else {
            // KLASİK: Hemen çektir ve atla
            const next = getNextPlayer(room);
            drawCards(room, next, 2);
            addLog(room, `${next.nickname} +2 yedi!`);
            skipNext = true;
        }
    }
    else if (card.value === 'wild4') {
        if (room.mode === 'UNO_X') {
            room.drawStack += 4;
            addLog(room, `⛓️ STACK! Toplam Ceza: ${room.drawStack} Kart`);
        }
        
        const nextIdx = getNextPlayerIndex(room);
        const nextPlayer = room.players[nextIdx];
        
        // UNO X'de de, Klasikte de Challenge hakkı vardır
        room.pendingChallenge = { 
            attackerId: player.id, 
            victimId: nextPlayer.id, 
            oldColor: oldColorForChallenge 
        };
        
        io.to(nextPlayer.id).emit('challengePrompt', { 
            attacker: player.nickname,
            stackAmount: room.mode === 'UNO_X' ? room.drawStack : 4
        });
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
            // UNO X: Stack varsa onu çeker
            const penalty = (room.mode === 'UNO_X' && room.drawStack > 0) ? room.drawStack : 1;
            drawCards(room, currentPlayer, penalty);
            room.drawStack = 0; // Stack reset
            addLog(room, `⏳ ${currentPlayer.nickname} süre doldu, ${penalty} kart çekti.`);
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
    io.to(room.id).emit('chatBroadcast', { sender: 'SİSTEM', msg: msg, type: 'log', time: '' });
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
                mode: room.mode,
                drawStack: room.drawStack, // İstemciye stack bilgisini gönder
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
                pendingDrawAction: room.pendingDrawAction && room.pendingDrawAction.playerId === p.id
            });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO Legend Server Aktif!'));
