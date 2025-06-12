import React, { useState, useEffect, useCallback, useRef } from 'react';

// A simple modal component for displaying the summary.
const Modal = ({ children, onClose }) => (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4" onClick={onClose}>
        <div className="bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-lg relative" onClick={e => e.stopPropagation()}>
            <button
                onClick={onClose}
                className="absolute top-2 right-2 text-gray-400 hover:text-white text-2xl"
                aria-label="Close modal"
            >
                &times;
            </button>
            {children}
        </div>
    </div>
);

/**
 * A component that renders text and automatically converts URLs into clickable links.
 * @param {{text: string}} props - The component props.
 */
const ClickableMessage = ({ text }) => {
    // Regex to find URLs in a string. It looks for http, https, or www protocols.
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
    const parts = text.split(urlRegex);

    return (
        <p className="text-gray-300 break-words whitespace-pre-wrap">
            {parts.map((part, index) => {
                if (part && part.match(urlRegex)) {
                    // Prepend https:// if the URL starts with www. for it to be a valid link.
                    const href = part.startsWith('www.') ? `https://${part}` : part;
                    return (
                        <a
                            key={index}
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 underline"
                        >
                            {part}
                        </a>
                    );
                }
                return part;
            })}
        </p>
    );
};


/**
 * Main App Component for the ntfy.sh client.
 *
 * This component provides a full-featured UI to interact with a ntfy server,
 * now enhanced with Gemini API features for message generation and summarization.
 * This version uses a robust `fetch` streaming implementation for receiving notifications
 * and persists message history to localStorage. It is ready for web deployment.
 */
const App = () => {
    const [server, setServer] = useState('https://ntfy.sh');
    const [topic, setTopic] = useState(() => {
        try {
            const storedTopic = localStorage.getItem('ntfy-latest-topic');
            return storedTopic || 'your-topic-here';
        } catch (error) {
            console.error("Failed to load latest topic from localStorage", error);
            return 'your-topic-here';
        }
    });
    const [messages, setMessages] = useState([]);
    const [newTitle, setNewTitle] = useState('');
    const [newMessage, setNewMessage] = useState('');
    const [connected, setConnected] = useState(false);
    const [errorInfo, setErrorInfo] = useState(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [summary, setSummary] = useState('');
    const [isSummaryModalOpen, setIsSummaryModalOpen] = useState(false);
    const [previousTopics, setPreviousTopics] = useState(() => {
        try {
            const storedTopics = localStorage.getItem('ntfy-previous-topics');
            return storedTopics ? JSON.parse(storedTopics) : [];
        } catch (error) {
            console.error("Failed to load previous topics from localStorage", error);
            return [];
        }
    });

    // useRef to hold the AbortController for cancellable fetch requests.
    const abortControllerRef = useRef(null);

    // Request notification permission on component mount
    useEffect(() => {
        if (!("Notification" in window)) {
            console.warn("This browser does not support desktop notification");
        } else if (Notification.permission !== "granted" && Notification.permission !== "denied") {
            Notification.requestPermission().then(permission => {
                if (permission === "granted") {
                    console.log("Notification permission granted.");
                } else {
                    console.warn("Notification permission denied.");
                }
            });
        }
    }, []);

    /**
     * The `subscribe` function establishes a connection to the ntfy server
     * using the `fetch` API to manually read the newline-delimited JSON stream.
     */
    const subscribe = useCallback(async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        if (!topic.trim()) {
            setConnected(false);
            setErrorInfo('Topic cannot be empty.');
            return;
        }

        // Load message history for the current topic from localStorage.
        try {
            const savedMessages = localStorage.getItem(`ntfy-history-${topic}`);
            setMessages(savedMessages ? JSON.parse(savedMessages) : []);
        } catch (error) {
            console.error(`Failed to load history for topic ${topic} from localStorage`, error);
            setMessages([]);
        }

        const cleanServer = server.replace(/\/$/, '');
        const fetchUrl = `${cleanServer}/${topic}/json`;
        
        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const response = await fetch(fetchUrl, {
                signal: controller.signal,
                cache: 'no-store'
            });

            if (!response.ok) {
                throw new Error(`Connection failed: ${response.status} ${response.statusText}`);
            }

            setConnected(true);
            setErrorInfo(null);
            console.log(`Subscribed to ${fetchUrl} using fetch streaming.`);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (!controller.signal.aborted) {
                        setConnected(false);
                        setErrorInfo('Connection closed.');
                    }
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); 

                for (const line of lines) {
                    if (line.trim() === '') continue;
                    try {
                        const parsedData = JSON.parse(line);
                        if (parsedData.id && parsedData.message) {
                            // Update state and save to localStorage.
                            setMessages(prevMessages => {
                                // Prevent duplicate messages from being added.
                                if (prevMessages.some(msg => msg.id === parsedData.id)) {
                                    return prevMessages;
                                }
                                // Add new message and limit history to 50 messages.
                                const newMessages = [parsedData, ...prevMessages].slice(0, 50);
                                localStorage.setItem(`ntfy-history-${topic}`, JSON.stringify(newMessages));
                                
                                // Show desktop notification if permission is granted
                                if (Notification.permission === "granted" && parsedData.message) {
                                    const notificationTitle = parsedData.title || `New message on topic: ${topic}`;
                                    new Notification(notificationTitle, {
                                        body: parsedData.message,
                                        icon: '/ntfy-logo.png' // Consider adding a logo in the public folder
                                    });
                                }
                                return newMessages;
                            });

                           // NOTE: The Electron-specific desktop notification code has been removed from this version.
                        }
                    } catch (e) {
                        console.error('Failed to parse message JSON from stream:', line, e);
                    }
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(`Subscription failed for URL: ${fetchUrl}.`, error);
                setConnected(false);
                setErrorInfo('Connection failed. Check console.');
            }
        }
    }, [topic, server]);

    // Effect to manage the subscription lifecycle.
    useEffect(() => {
        subscribe();
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [subscribe]);

    // Effect to save the current topic to localStorage and manage previous topics
    useEffect(() => {
        if (topic.trim()) {
            // Save latest topic
            localStorage.setItem('ntfy-latest-topic', topic.trim());

            // Manage previous topics
            setPreviousTopics(prevTopics => {
                const newTopics = [topic.trim(), ...prevTopics.filter(t => t !== topic.trim())].slice(0, 10); // Keep last 10 topics
                localStorage.setItem('ntfy-previous-topics', JSON.stringify(newTopics));
                return newTopics;
            });
        }
    }, [topic, setPreviousTopics]);

    const handleTopicClick = (clickedTopic) => {
        setTopic(clickedTopic);
    };

    const handleRemoveTopic = (topicToRemove) => {
        setPreviousTopics(prevTopics => {
            const newTopics = prevTopics.filter(topic => topic !== topicToRemove);
            localStorage.setItem('ntfy-previous-topics', JSON.stringify(newTopics));
            return newTopics;
        });
    };
    
    /**
     * Sends a notification to the current topic.
     */
    const sendMessage = async () => {
        if (!newMessage.trim() || !topic.trim()) return;
        try {
            const cleanServer = server.replace(/\/$/, '');
            const headers = { 'Priority': 'default', 'Tags': 'rocket' };
            if (newTitle.trim()) {
                headers['Title'] = newTitle.trim();
            }

            await fetch(`${cleanServer}/${topic}`, {
                method: 'POST',
                body: newMessage,
                headers: headers
            });
            setNewMessage('');
            setNewTitle('');
        } catch (error) {
            console.error("Failed to send message:", error);
        }
    };
    
    /**
     * ✨ Uses the Gemini API to generate a notification message from a prompt.
     */
    const handleGenerateMessage = async () => {
        if (!newMessage.trim()) {
            setErrorInfo("Please enter a prompt to generate a message.");
            return;
        }
        setIsGenerating(true);
        setErrorInfo(null);
        
        const prompt = `Based on the following prompt, write a concise and friendly notification message suitable for the ntfy.sh service. The message should be a single paragraph. Prompt: "${newMessage}"`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        const apiKey = "";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
                setNewMessage(result.candidates[0].content.parts[0].text);
            } else {
                throw new Error('Invalid response structure from Gemini API.');
            }
        } catch (error) {
            console.error("Gemini API call failed:", error);
            setErrorInfo("Failed to generate message. Check console.");
        } finally {
            setIsGenerating(false);
        }
    };

    /**
     * ✨ Uses the Gemini API to summarize all received messages.
     */
    const handleSummarize = async () => {
        if (messages.length === 0) return;
        setIsGenerating(true);
        setErrorInfo(null);

        const messagesText = messages.map(msg => `- ${msg.message}`).join('\n');
        const prompt = `Please provide a brief, bulleted summary of the following notifications:\n\n${messagesText}`;
        const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
        const apiKey = "";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (result.candidates?.[0]?.content?.parts?.[0]?.text) {
                setSummary(result.candidates[0].content.parts[0].text);
                setIsSummaryModalOpen(true);
            } else {
                throw new Error('Invalid response structure from Gemini API.');
            }
        } catch (error) {
            console.error("Gemini API call failed:", error);
            setErrorInfo("Failed to summarize messages. Check console.");
        } finally {
            setIsGenerating(false);
        }
    };
    
    /**
     * Clears messages from state and localStorage for the current topic.
     */
    const handleClearMessages = () => {
        setMessages([]);
        localStorage.removeItem(`ntfy-history-${topic}`);
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    return (
        <div className="bg-gray-900 text-white min-h-screen font-sans flex flex-col p-4 sm:p-6 md:p-8">
            <div className="max-w-4xl w-full mx-auto">
                <header className="mb-8 text-center">
                    <h1 className="text-4xl md:text-5xl font-bold text-purple-400">ntfy.sh React Client</h1>
                    <p className="text-gray-400 mt-2">Enhanced with Gemini AI ✨</p>
                </header>

                <div id="messages" className="bg-gray-800 p-6 rounded-lg shadow-lg mb-8">
                    <div className="flex justify-between items-center mb-4">
                         <h2 className="text-2xl font-semibold text-purple-300">Received Messages</h2>
                         <button onClick={handleSummarize} disabled={messages.length === 0 || isGenerating} className="bg-teal-600 hover:bg-teal-500 text-white font-bold py-2 px-4 rounded-md transition duration-300 text-sm disabled:bg-gray-500 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                            {isGenerating ? '...' : '✨ Summarize'}
                         </button>
                    </div>
                    <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
                        {messages.length > 0 ? (
                            messages.map((msg) => (
                                <div key={msg.id} className="bg-gray-700 p-4 rounded-md shadow animate-fade-in">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="font-bold text-purple-400 break-all">{msg.title || 'No Title'}</span>
                                        <span className="text-xs text-gray-400 flex-shrink-0 ml-2">{new Date(msg.time * 1000).toLocaleString()}</span>
                                    </div>
                                    <ClickableMessage text={msg.message} />
                                    {msg.tags && msg.tags.length > 0 && (<div className="mt-2 flex flex-wrap gap-2">{msg.tags.map(tag => (<span key={tag} className="bg-gray-600 text-xs text-gray-300 px-2 py-1 rounded-full">{tag}</span>))}</div>)}
                                </div>
                            ))
                        ) : (
                            <p className="text-gray-400 text-center py-4">Waiting for notifications on topic: "{topic}"</p>
                        )}
                    </div>
                </div>
                <div id="settings" className="bg-gray-800 p-6 rounded-lg shadow-lg mb-8">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        
                        <div>
                             <label htmlFor="server" className="block text-sm font-medium text-gray-300 mb-2">ntfy Server</label>
                             <input id="server" type="text" value={server} onChange={(e) => setServer(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-purple-500 transition" placeholder="e.g., https://ntfy.sh" />
                        </div>
                        <div>
                            <label htmlFor="topic" className="block text-sm font-medium text-gray-300 mb-2">Topic</label>
                            <input id="topic" type="text" value={topic} onChange={(e) => setTopic(e.target.value)} className="w-full bg-gray-700 border border-gray-600 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-purple-500 transition" placeholder="Enter a topic to subscribe" />
                        </div>
                    </div>
                    <div className="flex items-center justify-between mt-4">
                        <div className="text-sm">
                            Connection Status:
                            <span className={`ml-2 font-semibold ${connected ? 'text-green-400' : 'text-red-400'}`}>{connected ? 'Connected' : 'Disconnected'}</span>
                            {errorInfo && ( <span className="ml-2 text-yellow-500 text-xs">({errorInfo})</span> )}
                        </div>
                         <button onClick={handleClearMessages} className="bg-gray-600 hover:bg-gray-500 text-white font-bold py-2 px-4 rounded-md transition duration-300 text-sm">Clear Messages</button>
                    </div>

                    {previousTopics.length > 0 && (
                        <div className="mt-6">
                            <h3 className="text-lg font-medium text-gray-300 mb-2">Previous Topics</h3>
                            <div className="flex flex-wrap gap-2">
                                {previousTopics.map((prevTopic, index) => (
                                    <div key={index} className="flex items-center bg-gray-700 rounded-full pr-1">
                                        <button
                                            onClick={() => handleTopicClick(prevTopic)}
                                            className="text-gray-200 text-sm px-3 py-1 transition duration-300"
                                        >
                                            {prevTopic}
                                        </button>
                                        <button
                                            onClick={() => handleRemoveTopic(prevTopic)}
                                            className="text-gray-400 hover:text-red-400 ml-1 p-1 rounded-full hover:bg-gray-600 transition duration-300"
                                            aria-label={`Remove topic ${prevTopic}`}
                                        >
                                            &times;
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div id="send" className="bg-gray-800 p-6 rounded-lg shadow-lg mb-8">
                    <h2 className="text-2xl font-semibold mb-4 text-purple-300">Send Notification</h2>
                    <div className="flex flex-col gap-4">
                         <input
                            type="text"
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            className="w-full bg-gray-700 border border-gray-600 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-purple-500 transition"
                            placeholder="Notification Title (optional)"
                         />
                         <textarea
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            onKeyPress={handleKeyPress}
                            className="flex-grow bg-gray-700 border border-gray-600 rounded-md py-2 px-3 focus:outline-none focus:ring-2 focus:ring-purple-500 transition h-24 resize-none"
                            placeholder="Type a message or a prompt for Gemini AI..."
                         />
                         <div className="flex flex-col sm:flex-row gap-2">
                             <button onClick={sendMessage} disabled={!newMessage.trim() || !topic.trim() || isGenerating} className="flex-1 bg-purple-600 hover:bg-purple-500 text-white font-bold py-2 px-5 rounded-md transition duration-300 disabled:bg-gray-500 disabled:cursor-not-allowed">Send</button>
                             <button onClick={handleGenerateMessage} disabled={!newMessage.trim() || isGenerating} className="flex-1 bg-teal-600 hover:bg-teal-500 text-white font-bold py-2 px-5 rounded-md transition duration-300 disabled:bg-gray-500 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                                 {isGenerating ? 'Generating...' : '✨ Generate Message'}
                             </button>
                         </div>
                    </div>
                </div>

            </div>

            {isSummaryModalOpen && (
                <Modal onClose={() => setIsSummaryModalOpen(false)}>
                    <h2 className="text-2xl font-semibold mb-4 text-teal-300">✨ Message Summary</h2>
                    <p className="text-gray-300 whitespace-pre-wrap">{summary}</p>
                </Modal>
            )}

            <style>{`
                @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
                .animate-fade-in { animation: fadeIn 0.5s ease-out forwards; }
                .custom-scrollbar::-webkit-scrollbar { width: 8px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: #2d3748; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #5a67d8; border-radius: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #4c51bf; }
            `}</style>
        </div>
    );
};

export default App;