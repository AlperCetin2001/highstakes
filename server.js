/* UNO PRO SERVER 
   - Orijinal 108 Kart Yapısı
   - Challenge (Meydan Okuma) Sistemi
   - Puanlama Sistemi
   - Gelişmiş Oda Yönetimi
*/

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

// --- OYUN SABİTLERİ VE VERİ YAPILARI ---
const CARD_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const COLORS = ['red', 'blue', 'green', 'yellow'];
const SPECIAL_CARDS = ['wild', 'draw4'];

class GameRoom {
    constructor(id, settings = {}) {
        this.id = id;
        this.players = []; // {id, name, avatar, hand, score, isReady}
        this.deck = [];
        this.discardPile = [];
        this.turnIndex = 0;
        this.direction = 1; // 1: Saat yönü, -1: Ters
        this.gameState = 'LOBBY'; // LOBBY, PLAYING, CHALLENGE_WAITING, SCORING
        this.settings = {
            stacking: settings.stacking || false, // Üst üste +2 atma
            targetScore: 500
        };
        this.pendingChallenge = null; // Challenge durumundaki veriler
        this.unoCallers = new Set(); // UNO diyenler
        this.drawStack = 0; // Birikmiş ceza kartları (Stacking için)
    }

    // 1. ORİJİNAL DESTE OLUŞTURMA (108 KART)
    createDeck() {
        this.deck = [];
        COLORS.forEach(color => {
            // 1 adet 0
            this.deck.push({ color, value: '0', type: 'number', id: Math.random().toString(36) });
            // 2 adet 1-9, Skip, Reverse, Draw2
            for (let i = 0; i < 2; i++) {
                for (let v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2']) {
                    this.deck.push({ color, value: v, type: v.length > 1 ? 'action' : 'number', id: Math.random().toString(36) });
                }
            }
        });
        // 4 Joker, 4 Joker+4
        for (let i = 0; i < 4; i++) {
            this.deck.push({ color: 'black', value: 'wild', type: 'wild', id: Math.random().toString(36) });
            this.deck.push({ color: 'black', value: 'draw4', type: 'wild', id: Math.random().toString(36) });
        }
        this.shuffle();
    }

    shuffle() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    // Kart Çekme Mantığı (Deste biterse discard'ı karıştır)
    draw(count) {
        const cards = [];
        for (let i = 0; i < count; i++) {
            if (this.deck.length === 0) {
                if (this.discardPile.length > 1) {
                    const top = this.discardPile.pop();
                    this.deck = this.discardPile; // Kalanları desteye koy
                    this.discardPile = [top]; // En üsttekini bırak
                    this.shuffle(); // Karıştır
                } else {
                    break; // Kart kalmadı
                }
            }
            cards.push(this.deck.pop());
        }
        return cards;
    }

    // Puan Hesaplama
    calculateScore(winner) {
        let total = 0;
        this.players.forEach(p => {
            if (p.id !== winner.id) {
                p.hand.forEach(c => {
                    if (!isNaN(c.value)) total += parseInt(c.value);
                    else if (['skip', 'reverse', 'draw2'].includes(c.value)) total += 20;
                    else if (['wild', 'draw4'].includes(c.value)) total += 50;
                });
            }
        });
        winner.score += total;
        return total;
    }
}

const rooms = {};

io.on('connection', (socket) => {
    
    // --- LOBİ İŞLEMLERİ ---
    
    socket.on('getRooms', () => {
        // Açık odaları listele
        const list = Object.values(rooms)
            .filter(r => r.gameState === 'LOBBY')
            .map(r => ({ id: r.id, count: r.players.length, settings: r.settings }));
        socket.emit('roomList', list);
    });

    socket.on('createRoom', ({ nickname, avatar, settings }) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = new GameRoom(roomId, settings);
        room.players.push({ id: socket.id, nickname, avatar, hand: [], score: 0, isHost: true });
        rooms[roomId] = room;
        socket.join(roomId);
        
        io.to(roomId).emit('roomUpdate', { players: room.players, roomId, isHost: true, settings: room.settings });
        io.emit('roomList', Object.values(rooms).filter(r => r.gameState === 'LOBBY').map(r => ({id:r.id, count:r.players.length})));
    });

    socket.on('joinRoom', ({ roomId, nickname, avatar }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('notification', { type: 'error', text: 'Oda bulunamadı!' });
        if (room.gameState !== 'LOBBY') return socket.emit('notification', { type: 'error', text: 'Oyun çoktan başladı!' });
        
        room.players.push({ id: socket.id, nickname, avatar, hand: [], score: 0, isHost: false });
        socket.join(roomId);
        
        io.to(roomId).emit('roomUpdate', { players: room.players, roomId, isHost: false, settings: room.settings });
    });

    // --- OYUN AKIŞI ---

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        
        room.gameState = 'PLAYING';
        room.createDeck();
        
        // 7'şer Kart Dağıt
        room.players.forEach(p => p.hand = room.draw(7));

        // İlk Kartı Aç (Wild olmamasına dikkat et - Basit kural)
        let firstCard = room.draw(1)[0];
        while (firstCard.color === 'black') {
            room.deck.push(firstCard);
            room.shuffle();
            firstCard = room.draw(1)[0];
        }
        room.discardPile.push(firstCard);

        // İLK KART ETKİLERİ
        if (firstCard.value === 'draw2') {
             // İlk oyuncuya 2 kart çektir mantığı eklenebilir ama basitlik için pas geçiyoruz şimdilik.
        } else if (firstCard.value === 'reverse') {
            room.direction *= -1;
            room.turnIndex = room.players.length - 1; // Son oyuncu başlar
        } else if (firstCard.value === 'skip') {
            room.turnIndex = 1; // İkinci oyuncu başlar
        }

        io.to(roomId).emit('gameStarted');
        updateGameState(roomId);
    });

    socket.on('playCard', ({ roomId, cardIndex, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.turnIndex) return;

        const card = player.hand[cardIndex];
        const topCard = room.discardPile[room.discardPile.length - 1];
        
        // --- BLÖF & CHALLENGE KONTROLÜ İÇİN VERİ HAZIRLIĞI ---
        const previousColor = topCard.displayColor || topCard.color;

        // Geçerlilik Kontrolü
        let isValid = false;
        if (card.color === 'black') isValid = true;
        else if (card.color === previousColor || card.value === topCard.value) isValid = true;

        if (!isValid) return socket.emit('notification', {type:'error', text:'Bu kartı oynayamazsın!'});

        // WILD DRAW 4 ÖZEL DURUMU (Blöf Mekaniği)
        if (card.value === 'draw4') {
            // Kartı geçici oynat ama sırayı hemen geçirme
            player.hand.splice(cardIndex, 1);
            card.displayColor = chosenColor;
            room.discardPile.push(card);

            // Challenge Bekleme Moduna Gir
            room.gameState = 'CHALLENGE_WAITING';
            const victimIndex = getNextPlayerIndex(room);
            const victim = room.players[victimIndex];
            
            room.pendingChallenge = {
                attackerId: player.id,
                victimId: victim.id,
                cardPlayed: card,
                prevColor: previousColor // Blöf kontrolü için eski renk
            };

            // Herkese durumu bildir, ama sadece kurbana buton gösterilecek
            updateGameState(roomId);
            return;
        }

        // Normal Oynama
        player.hand.splice(cardIndex, 1);
        if (card.color === 'black') card.displayColor = chosenColor;
        room.discardPile.push(card);

        handleCardEffect(room, card);
    });

    // CHALLENGE YANITI
    socket.on('respondChallenge', ({ roomId, action }) => { // action: 'accept' veya 'challenge'
        const room = rooms[roomId];
        if(!room || room.gameState !== 'CHALLENGE_WAITING') return;
        
        const { attackerId, victimId, prevColor } = room.pendingChallenge;
        if(socket.id !== victimId) return; // Sadece kurban yanıt verebilir

        const attacker = room.players.find(p => p.id === attackerId);
        const victim = room.players.find(p => p.id === victimId);

        if (action === 'accept') {
            // Meydan okumadı, 4 kart ye
            victim.hand.push(...room.draw(4));
            room.turnIndex = getNextPlayerIndex(room); // Sıra kurbanı atlar
            io.to(roomId).emit('notification', {type:'info', text:`${victim.nickname} cezayı kabul etti (+4).`});
        } else {
            // MEYDAN OKUDU!
            // Attacker'ın elinde 'prevColor' renginden kart var mıydı?
            // (Not: Attacker kartı çoktan attı, o yüzden elinde kalanlara bakıyoruz. 
            // Ama kural: Oynadığı an elinde başka o renkten var mıydı? 
            // Basitlik için: Şu an elinde o renkten kart var mı diye bakalım.)
            const hasColor = attacker.hand.some(c => c.color === prevColor);

            if (hasColor) {
                // SUÇLU! (Blöf yapmış)
                attacker.hand.push(...room.draw(4)); // Attacker ceza yer
                io.to(roomId).emit('notification', {type:'success', text:`BLÖF YAKALANDI! ${attacker.nickname} +4 yiyor!`});
                // Sıra kurbana geçer (ceza yemez) ve oynar mı? Hayır, kurala göre sadece ceza aktarılır.
                // Orijinal kural: Kurban kart çekmez, oyun devam eder.
            } else {
                // SUÇSUZ! (Dürüst oynamış)
                victim.hand.push(...room.draw(6)); // Kurban 4+2=6 yer
                io.to(roomId).emit('notification', {type:'error', text:`MEYDAN OKUMA BAŞARISIZ! ${victim.nickname} +6 yiyor!`});
                room.turnIndex = getNextPlayerIndex(room); // Sıra kurbanı atlar
            }
        }

        room.gameState = 'PLAYING';
        room.pendingChallenge = null;
        advanceTurn(room); // Sırayı ilerlet
        updateGameState(roomId);
    });

    socket.on('drawCard', (roomId) => {
        const room = rooms[roomId];
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (room.players.indexOf(player) !== room.turnIndex) return;

        const drawn = room.draw(1)[0];
        player.hand.push(drawn);
        
        io.to(roomId).emit('notification', {type:'info', text:`${player.nickname} kart çekti.`});
        
        // Çekilen kart oynanabilir mi?
        const top = room.discardPile[room.discardPile.length - 1];
        const col = top.displayColor || top.color;
        
        if (drawn.color === 'black' || drawn.color === col || drawn.value === top.value) {
            // Oynanabilir, istemciye bunu belirtebiliriz veya oynamasına izin veririz.
            // Otomatik geçmiyoruz, oyuncu isterse oynar.
        } else {
            // Oynanamazsa sıra geçer
            // (Orijinal kural: Oyuncu isterse oynar, oynamazsa pas geçer. Biz otomatik geçelim kolaylık için)
            // advanceTurn(room); 
        }
        updateGameState(roomId);
    });

    socket.on('passTurn', (roomId) => {
        const room = rooms[roomId];
        if(room) {
             advanceTurn(room);
             updateGameState(roomId);
        }
    });

    socket.on('callUno', (roomId) => {
        const room = rooms[roomId];
        if(room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if(p && p.hand.length <= 2) {
                room.unoCallers.add(p.id);
                io.to(roomId).emit('notification', {type:'success', text:`${p.nickname}: UNO!!!`});
                io.to(roomId).emit('playSound', 'uno');
            }
        }
    });

    // --- YARDIMCI FONKSİYONLAR ---
    function handleCardEffect(room, card) {
        // UNO KONTROLÜ: Eğer oyuncunun 1 kartı kaldıysa ve UNO demediyse ceza yiyebilir
        // (Burada otomatik kontrol yerine "Challenge UNO" butonu eklenebilir. Şimdilik basit tutuyoruz)
        const player = room.players[room.turnIndex];
        if (player.hand.length === 0) {
            // OYUN BİTTİ
            const points = room.calculateScore(player);
            io.to(room.id).emit('gameOver', { winner: player, points });
            room.gameState = 'SCORING';
            return;
        }

        if (card.value === 'skip') {
            advanceTurn(room); // Bir kişi atla
        } else if (card.value === 'reverse') {
            room.direction *= -1;
            if (room.players.length === 2) advanceTurn(room); // 2 kişide skip gibi
        } else if (card.value === 'draw2') {
            if (room.settings.stacking) {
                // Stack mantığı (eklenmedi, çok karmaşıklaşır, şimdilik düz)
            }
            const nextP = getNextPlayerIndex(room);
            room.players[nextP].hand.push(...room.draw(2));
            advanceTurn(room); // +2 yiyen sırasını kaybeder
        }
        
        advanceTurn(room);
        updateGameState(room.id);
    }

    function advanceTurn(room) {
        room.turnIndex = (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }

    function getNextPlayerIndex(room) {
        return (room.turnIndex + room.direction + room.players.length) % room.players.length;
    }

    function updateGameState(roomId) {
        const room = rooms[roomId];
        room.players.forEach((p, i) => {
            io.to(p.id).emit('gameState', {
                hand: p.hand,
                topCard: room.discardPile[room.discardPile.length - 1],
                isMyTurn: i === room.turnIndex && room.gameState === 'PLAYING',
                turnIndex: room.turnIndex,
                gameState: room.gameState,
                challengeData: room.pendingChallenge, // Kurbanın ekranında buton çıkarmak için
                players: room.players.map(pl => ({ 
                    id: pl.id, 
                    nickname: pl.nickname, 
                    avatar: pl.avatar, 
                    cardCount: pl.hand.length,
                    isUno: room.unoCallers.has(pl.id)
                }))
            });
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('UNO PRO SERVER READY'));
