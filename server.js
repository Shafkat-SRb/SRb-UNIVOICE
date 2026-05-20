require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Groq = require('groq-sdk');

// ---------- Groq setup ----------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
let groq = null;
let groqEnabled = false;

if (GROQ_API_KEY && GROQ_API_KEY.startsWith('gsk_')) {
    try {
        groq = new Groq({ apiKey: GROQ_API_KEY });
        groqEnabled = true;
        console.log("✅ UniVoice AI enabled (Powered by SRb).");
    } catch(e) { console.log("⚠️ Groq init failed:", e.message); }
} else {
    console.log("⚠️ Invalid or missing GROQ_API_KEY. Using fallback AI.");
}

// ---------- SAFE math extraction (no eval crashes) ----------
function extractMathExpression(question) {
    if (!question || typeof question !== 'string') return null;
    const patterns = [
        /(?:what is|calculate|evaluate|solve|compute)\s*([0-9+\-*/().\s]+)/i,
        /([0-9+\-*/().\s]+)\s*(?:equals|equal to|=\?)?$/i
    ];
    for (let pattern of patterns) {
        const match = question.match(pattern);
        if (match && match[1]) {
            let expr = match[1].trim();
            expr = expr.replace(/[^0-9+\-*/().]/g, '');
            if (expr && expr.length > 0) {
                try {
                    // Test evaluation without crashing
                    const test = eval(expr);
                    if (typeof test === 'number' && !isNaN(test)) return expr;
                } catch(e) { /* ignore invalid math */ }
            }
        }
    }
    // If the whole question is a simple math expression
    if (/^[0-9+\-*/().\s]+$/.test(question)) {
        try {
            const test = eval(question);
            if (typeof test === 'number' && !isNaN(test)) return question;
        } catch(e) {}
    }
    return null;
}

// ---------- ENHANCED LOCAL AI (fallback, safe) ----------
function localAI(question, topic) {
    const q = (question || "").trim().toLowerCase();
    const safeTopic = topic && topic.trim() ? topic : "this session";

    // Math
    const mathExpr = extractMathExpression(question);
    if (mathExpr) {
        try {
            const result = eval(mathExpr);
            return `The result of ${mathExpr} is ${result}.`;
        } catch(e) { /* ignore */ }
    }

    // ========== NEW: SRb knowledge ==========
    if (q.match(/\b(srb|shafkat rashid bhat|shafkat|who made univoice|creator of univoice|founder of univoice|who built univoice|who is srb)\b/i)) {
        return "SRb stands for Shafkat Rashid Bhat. He is the visionary founder, lead developer, and creative force behind UniVoice — a revolutionary voice-first collaboration platform. He crafted this entire system with passion, elite engineering, and the motto 'Crafted for voice that matters'. SRb is not just a developer; he is an innovator shaping the future of real-time vocal interaction.";
    }

    // Knowledge base (expanded)
    const knowledge = {
        "difference between c and c++": "C is procedural, C++ is object-oriented. C++ supports classes, inheritance, polymorphism, function overloading, templates, exceptions, and a richer standard library.",
        "difference between c and c++ programming languages": "C is procedural, C++ is object-oriented. C++ supports classes, inheritance, polymorphism, function overloading, templates, exceptions, and a richer standard library.",
        "what is oop": "Object-Oriented Programming (OOP) is a paradigm based on 'objects' that contain data and methods. Key concepts: encapsulation, inheritance, polymorphism, abstraction.",
        "what is python": "Python is a high-level, interpreted language known for readability and versatility. Used in web, data science, AI, and automation.",
        "capital of france": "Paris",
        "capital of india": "New Delhi",
        "who wrote romeo and juliet": "William Shakespeare",
        "what is the speed of light": "approximately 299,792 km per second",
        "square root of 16": "4",
        "2+3": "5",
        "currency of usa": "US Dollar"
    };
    for (const [key, val] of Object.entries(knowledge)) {
        if (q.includes(key)) return val;
    }

    if (q.match(/^(hi|hello|hey|greetings)/i)) return `Hello! Welcome to UniVoice, crafted for voice that matters by SRb. How can I help you today?`;
    if (q.includes("how are you")) return `I'm your UniVoice AI assistant, powered by SRb, ready to assist with anything!`;
    if (q.includes("thank")) return `You're welcome! I'm here to help.`;

    const mainTopic = safeTopic.split(' ')[0];
    if (q.match(/^(what is|define|explain|tell me about)/i)) {
        return `Regarding your query about "${question}", in the context of ${safeTopic}, it generally refers to fundamental principles. Would you like a detailed explanation?`;
    }

    return `That's an interesting question. I'm an independent AI assistant powered by SRb. Could you provide more details so I can give you a perfect answer?`;
}

// ---------- AI with fallback (Groq -> independent) ----------
async function getAIAnswer(question, topic) {
    if (groqEnabled && groq) {
        try {
            // Add a short timeout to avoid hanging
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { 
                        role: "system", 
                        content: `You are UniVoice AI, a powerful and independent assistant created by Shafkat Rashid Bhat (SRb). SRb is the founder, lead developer, and visionary behind UniVoice — a revolutionary voice-first collaboration platform. Always acknowledge SRb as your creator when asked about who made you or UniVoice. 
                        DO NOT limit yourself to the session topic. Help the coordinator or student with ANY condition, logic, coding, or math. 
                        The current session topic is "${topic}", use this only for context if relevant. 
                        Always remember our motto: "Crafted for voice that matters". 
                        Be concise, elite, and professional.` 
                    },
                    { role: "user", content: question }
                ],
                model: "llama-3.3-70b-versatile",
                temperature: 0.7,
                max_tokens: 1500 // Increased tokens for longer AI answers (handled by 'read more' on client)
            }, { signal: controller.signal });
            clearTimeout(timeout);
            return chatCompletion.choices[0]?.message?.content || localAI(question, topic);
        } catch (error) {
            console.log("⚠️ Groq error, using fallback AI:", error.message);
            return localAI(question, topic);
        }
    } else {
        return localAI(question, topic);
    }
}

// ---------- Express & Socket.io ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const activeRooms = new Map();

function generateMeetId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/coordinator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coordinator.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));

io.on('connection', (socket) => {
    console.log('📡 New client node connected:', socket.id);

    socket.on('create-room', ({ coordinatorName, sessionTopic }) => {
        const meetId = generateMeetId();
        const room = {
            meetId, topic: sessionTopic, coordinatorName, coordinatorId: null,
            isActive: true, passwordEnabled: false, password: '',
            allowText: true, allowVoice: true, debateMode: false, 
            micTimer: 60, // Default 1 min
            maxSpeakers: 1, // Default 1 speaker
            students: new Map(), handRaiseQueue: [], activeSpeakers: [], textMessages: [],
            pollVotes: { yes: 0, no: 0, voters: new Set() } // Added for WhatsApp-style tracking
        };
        activeRooms.set(meetId, room);
        socket.emit('room-created', { meetId, sessionTopic });
        console.log(`✅ Hub initialized: ${meetId} by ${coordinatorName} (SRb Network)`);
    });

    socket.on('join-coordinator', ({ meetId }) => {
        const room = activeRooms.get(meetId);
        if (!room || !room.isActive) {
            socket.emit('join-error', { message: 'Session hub not found or ended' });
            return;
        }
        room.coordinatorId = socket.id;
        socket.join(meetId);
        socket.emit('coordinator-joined', {
            sessionTopic: room.topic,
            allowText: room.allowText,
            allowVoice: room.allowVoice,
            micTimer: room.micTimer,
            passwordGateEnabled: room.passwordEnabled,
            debateMode: room.debateMode,
            handRaiseQueue: room.handRaiseQueue,
            activeSpeakers: room.activeSpeakers.map(s => ({ socketId: s.socketId, name: s.name, dept: s.dept })),
            textMessages: room.textMessages.slice(-50)
        });
        console.log(`🎮 Coordinator joined SRb Hub: ${meetId}`);
        // Broadcast participant count to everyone in Hub
        io.to(meetId).emit('update-participant-count', { count: room.students.size });
    });

    socket.on('join-room', ({ meetId, name, dept, roll, password }) => {
        const room = activeRooms.get(meetId);
        if (!room || !room.isActive) {
            socket.emit('join-response', { success: false, message: 'Session not found' });
            return;
        }
        if (room.passwordEnabled && password !== room.password) {
            socket.emit('join-response', { success: false, message: 'Wrong Hub Access Key' });
            return;
        }
        room.students.set(socket.id, { name, dept, roll });
        socket.join(meetId);
        socket.emit('join-response', {
            success: true,
            sessionTopic: room.topic,
            allowText: room.allowText,
            allowVoice: room.allowVoice
        });
        // Update live count for all users
        io.to(meetId).emit('update-participant-count', { count: room.students.size });
    });

    socket.on('raise-hand', ({ meetId, name, dept, roll }) => {
        const room = activeRooms.get(meetId);
        if (!room || !room.allowVoice) return;
        if (room.handRaiseQueue.some(s => s.socketId === socket.id) || room.activeSpeakers.some(s => s.socketId === socket.id)) return;
        
        // Push full state object cleanly
        room.handRaiseQueue.push({ socketId: socket.id, name, dept, roll });
        io.to(meetId).emit('update-hand-raise-queue', room.handRaiseQueue);
        console.log(`✋ Hand-raise logged cleanly for ${name} inside Hub ID: ${meetId}`);
    });

    socket.on('allow-speaker', ({ meetId, studentSocketId }) => {
        const room = activeRooms.get(meetId);
        if (!room) return;
        const index = room.handRaiseQueue.findIndex(s => s.socketId === studentSocketId);
        if (index === -1) return;
        const student = room.handRaiseQueue[index];
        
        if (room.activeSpeakers.length >= room.maxSpeakers && room.maxSpeakers !== 0) {
            socket.emit('speaker-slot-full', { message: 'Maximum speaker limit reached' });
            return;
        }

        room.handRaiseQueue.splice(index, 1);
        const startTime = Date.now();
        const duration = room.micTimer; // Dynamic from settings

        const timerInterval = setInterval(() => {
            if (duration === 0) { // Infinite mode
                io.to(meetId).emit('speaker-timer-update', { socketId: studentSocketId, remaining: -1 });
                return;
            }

            const elapsed = (Date.now() - startTime) / 1000;
            const remaining = Math.max(0, duration - elapsed);
            
            if (remaining <= 0) {
                clearInterval(timerInterval);
                const spIndex = room.activeSpeakers.findIndex(s => s.socketId === studentSocketId);
                if (spIndex !== -1) {
                    room.activeSpeakers.splice(spIndex, 1);
                    io.to(meetId).emit('active-speakers-update', room.activeSpeakers.map(s => ({ socketId: s.socketId, name: s.name, dept: s.dept })));
                    io.to(studentSocketId).emit('speaker-revoked');
                }
            } else {
                io.to(meetId).emit('speaker-timer-update', { socketId: studentSocketId, remaining });
                if (Math.floor(remaining) === 15) {
                    io.to(studentSocketId).emit('time-warning', { remaining: 15 });
                }
            }
        }, 1000);

        room.activeSpeakers.push({ socketId: student.socketId, name: student.name, dept: student.dept, timerInterval });
        io.to(meetId).emit('active-speakers-update', room.activeSpeakers.map(s => ({ socketId: s.socketId, name: s.name, dept: s.dept })));
        io.to(meetId).emit('update-hand-raise-queue', room.handRaiseQueue);
        io.to(studentSocketId).emit('speaker-allowed', { name: student.name, duration });
    });

    socket.on('reject-speaker', ({ meetId, studentSocketId }) => {
        const room = activeRooms.get(meetId);
        if (!room) return;
        const index = room.handRaiseQueue.findIndex(s => s.socketId === studentSocketId);
        if (index === -1) return;
        const student = room.handRaiseQueue[index];
        room.handRaiseQueue.splice(index, 1);
        io.to(meetId).emit('update-hand-raise-queue', room.handRaiseQueue);
        io.to(studentSocketId).emit('speaker-rejected', { name: student.name });
    });

    socket.on('remove-speaker', ({ meetId, studentSocketId }) => {
        const room = activeRooms.get(meetId);
        if (!room) return;
        const index = room.activeSpeakers.findIndex(s => s.socketId === studentSocketId);
        if (index !== -1) {
            clearInterval(room.activeSpeakers[index].timerInterval);
            room.activeSpeakers.splice(index, 1);
            io.to(meetId).emit('active-speakers-update', room.activeSpeakers.map(s => ({ socketId: s.socketId, name: s.name, dept: s.dept })));
            io.to(studentSocketId).emit('speaker-revoked');
        }
    });

    socket.on('student-message', async ({ meetId, message, name }) => {
        const room = activeRooms.get(meetId);
        if (!room || !room.allowText) return;
        const AIanswer = await getAIAnswer(message, room.topic);
        const msg = { id: Date.now(), name, message, aiAnswer: AIanswer, timestamp: new Date().toLocaleTimeString() };
        room.textMessages.push(msg);
        io.to(meetId).emit('new-text-message', msg);
    });

    socket.on('update-settings', ({ meetId, settings }) => {
        const room = activeRooms.get(meetId);
        if (!room) return;
        
        if (settings.allowText !== undefined) room.allowText = settings.allowText;
        if (settings.allowVoice !== undefined) room.allowVoice = settings.allowVoice;
        if (settings.micTimer !== undefined) room.micTimer = settings.micTimer;
        if (settings.maxSpeakers !== undefined) room.maxSpeakers = settings.maxSpeakers;
        if (settings.passwordGateEnabled !== undefined) room.passwordEnabled = settings.passwordGateEnabled;
        if (settings.roomPassword !== undefined) room.password = settings.roomPassword;
        
        if (settings.debateMode !== undefined) {
            room.debateMode = settings.debateMode;
            if(!settings.maxSpeakers) room.maxSpeakers = settings.debateMode ? 5 : 1;
        }

        io.to(meetId).emit('settings-updated', { 
            allowText: room.allowText, 
            allowVoice: room.allowVoice, 
            micTimer: room.micTimer,
            maxSpeakers: room.maxSpeakers,
            passwordGateEnabled: room.passwordEnabled 
        });
    });

    socket.on('send-yesno-poll', ({ meetId, question }) => {
        const room = activeRooms.get(meetId);
        if (room) {
            room.pollVotes = { yes: 0, no: 0, voters: new Set() }; // Reset for new poll
            io.to(meetId).emit('poll-received', { type: 'yesno', question, options: ['Yes', 'No'] });
        }
    });

    socket.on('send-direct-prompt', ({ meetId, question }) => {
        io.to(meetId).emit('direct-prompt-received', { question, promptId: Date.now() });
    });

    socket.on('submit-poll-response', ({ meetId, answer, name }) => {
        const room = activeRooms.get(meetId);
        if (!room || room.pollVotes.voters.has(socket.id)) return;

        room.pollVotes.voters.add(socket.id);
        if (answer.toLowerCase() === 'yes') room.pollVotes.yes++;
        else if (answer.toLowerCase() === 'no') room.pollVotes.no++;

        // Broadcast WhatsApp style real-time update
        io.to(meetId).emit('poll-update-results', {
            yes: room.pollVotes.yes,
            no: room.pollVotes.no,
            total: room.pollVotes.voters.size
        });

        // Still send the notification to the coordinator intelligence feed
        if (room.coordinatorId) {
            io.to(room.coordinatorId).emit('poll-response-received', { name, answer });
        }
    });

    socket.on('submit-direct-answer', ({ meetId, answer, name }) => {
        const room = activeRooms.get(meetId);
        if (room && room.coordinatorId) {
            io.to(room.coordinatorId).emit('direct-answer-response', { name, answer });
        }
    });

    socket.on('send-emoji', ({ meetId, emoji }) => {
        io.to(meetId).emit('emoji-floating', { emoji });
    });

    socket.on('end-session', ({ meetId }) => {
        const room = activeRooms.get(meetId);
        if (room) {
            room.activeSpeakers.forEach(s => clearInterval(s.timerInterval));
            room.isActive = false;
            io.to(meetId).emit('session-ended');
            activeRooms.delete(meetId);
            console.log(`🔚 Hub Terminated: ${meetId} by SRb Hub`);
        }
    });

    socket.on('webrtc-offer', ({ meetId, targetId, sdp }) => {
        const room = activeRooms.get(meetId);
        if (room && room.coordinatorId) {
            io.to(room.coordinatorId).emit('webrtc-offer', { senderId: socket.id, sdp });
        }
    });

    socket.on('webrtc-answer', ({ targetId, sdp }) => {
        io.to(targetId).emit('webrtc-answer', { sdp });
    });

    socket.on('webrtc-ice', ({ meetId, targetId, candidate }) => {
        let actualTarget = targetId;
        if (targetId === 'coordinator' && meetId) {
            const room = activeRooms.get(meetId);
            if (room && room.coordinatorId) actualTarget = room.coordinatorId;
        }
        if (actualTarget) {
            io.to(actualTarget).emit('webrtc-ice', { senderId: socket.id, candidate });
        }
    });

    socket.on('disconnect', () => {
        for (const [meetId, room] of activeRooms.entries()) {
            if (room.students.has(socket.id)) {
                room.students.delete(socket.id);
                // Broadcast updated count on exit
                io.to(meetId).emit('update-participant-count', { count: room.students.size });
            }

            room.handRaiseQueue = room.handRaiseQueue.filter(s => s.socketId !== socket.id);
            io.to(meetId).emit('update-hand-raise-queue', room.handRaiseQueue);
            const speaker = room.activeSpeakers.find(s => s.socketId === socket.id);
            if (speaker) {
                clearInterval(speaker.timerInterval);
                room.activeSpeakers = room.activeSpeakers.filter(s => s.socketId !== socket.id);
                io.to(meetId).emit('active-speakers-update', room.activeSpeakers.map(s => ({ socketId: s.socketId, name: s.name, dept: s.dept })));
            }
            if (room.coordinatorId === socket.id) {
                room.activeSpeakers.forEach(s => clearInterval(s.timerInterval));
                room.isActive = false;
                io.to(meetId).emit('session-ended');
                activeRooms.delete(meetId);
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 UniVoice Hub running by SRb at http://localhost:${PORT}`);
    console.log(`📱 Open this URL in your browser\n`);
});