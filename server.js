/* UNO PRO SERVER - Render.com için optimize edilmiş */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// CORS ayarlarını genişlet - Render.com için
app.use(cors({
    origin: ["https://doshu.gamer.gd", "http://localhost:3000", "https://highstakes-zdbp.onrender.com"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// Preflight requests
app.options('*', cors());

// Static files
app.use(express.static(__dirname));
app.use(express.json());

// Health check endpoint for Render.com
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        server: 'UNO PRO',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Main route
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const server = http.createServer(app);

// Socket.IO configuration for Render.com
const io = new Server(server, {
    cors: {
        origin: ["https://doshu.gamer.gd", "http://localhost:3000", "https://highstakes-zdbp.onrender.com"],
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    cookie: false
});

// --- GAME LOGIC (Aynı kalabilir, önceki server.js'den kopyalayın) ---
// Buraya önceki server.js'deki GameRoom class'ını ve oyun mantığını kopyalayın
// Kısaltma için tekrar yazmıyorum, önceki server.js dosyanızı kullanın

const rooms = {};

io.on('connection', (socket) => {
    console.log('🔗 Yeni bağlantı:', socket.id, 'IP:', socket.handshake.address);
    
    // Health check
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') {
            callback('pong');
        }
    });
    
    // ... kalan tüm socket olayları önceki server.js'deki gibi ...
    // Lütfen önceki server.js kodunuzu buraya kopyalayın
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 UNO PRO SERVER çalışıyor - Port: ${PORT}`);
    console.log(`🌐 Sunucu URL: https://highstakes-zdbp.onrender.com`);
    console.log(`🔗 WebSocket URL: wss://highstakes-zdbp.onrender.com`);
    console.log(`📡 CORS izin verilen: https://doshu.gamer.gd`);
});
