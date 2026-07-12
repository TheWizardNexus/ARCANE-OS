const CACHE_NAME = 'PreCrisis-cache-v35';
const urlsToCache = [
    './',
    './index.html',
    './admin.html',
    './chat.html',
    './data.html',
    './dashboard.html',
    './dashboard-clinical.html',
    './dashboard-leadership.html',
    './export.html',
    './import.html',
    './import-many.html',
    './journal.html',
    './manifest.json',
    './soc.html',

    './css/layout.css',
    './css/layout.css?v=2',
    './css/layout.css?v=3',
    './css/dashboard-config.css',
    './css/dashboard-config.css?v=1',
    
    './img/1024.png',
    './img/512.png',
    './img/256.png',
    './img/192.png',
    './img/arrow-left.png',
    './img/arrow-right.png',
    './img/doc.svg',
    './img/favicon.png',
    './img/folder.svg',
    './img/refresh.png',
    './img/trash.svg',
    
    './modules/AI.js?v=3',
    './modules/AssessmentRecords.js',
    './modules/AssessmentReportRunner.js',
    './modules/AssessmentTools.js',
    './modules/ChatRecords.js',
    './modules/ChartLibrary.js',
    './modules/CrisisModal.js',
    './modules/DashboardCharts.js',
    './modules/DashboardData.js',
    './modules/DataMaintenance.js',
    './modules/DataMaintenance.js?v=2',
    './modules/DataMaintenance.js?v=3',
    './modules/DBOPFS.js',
    './modules/DBOPFSWorker.js',
    './modules/DBLS.js',
    './modules/Errors.js?v=2',
    './modules/HTMLImport.js',
    './modules/HTMLImport.js?v=2',
    './modules/Mail.js',
    './modules/MailTransport.mjs',
    './modules/MD.js',
    './modules/MD.js?v=2',
    './modules/Marked.min.js',
    './modules/MemoryRecords.js',
    './modules/PostSaveAssessment.js',
    './modules/PostSaveAssessmentUI.js',
    './modules/QRCode.min.js',
    './modules/ToolCallRouter.js',
    './modules/uPlot.iife.min.js',
    './modules/uPlot.min.css',
    './modules/WaitForComponent.js',
    
    './components/chat.html',	
    './components/chat.html?v=3',
    './components/chart.html',
    './components/chart.html?v=1',
    './components/chart.html?v=2',
    './components/chart.html?v=3',
    './components/dashboard-config.html',
    './components/dashboard-config.html?v=1',
    './components/dashboard-config.html?v=2',
    './components/data-maintenance.html',
    './components/data-maintenance.html?v=1',
    './components/data-maintenance.html?v=2',
    './components/data-maintenance.html?v=3',
    './components/data-view.html',
    './components/data-view.html?v=1',
    './components/data-view.html?v=2',
    './components/data-view.html?v=3',
    './components/data-view.html?v=4',
    './components/file-manager.html',
    './components/file-manager.html?v=2',
    './components/file-manager.html?v=3',
    './components/file-manager.html?v=4',
    './components/file-manager.html?v=5',
    './components/file-manager.html?v=6',
    './components/file-manager.html?v=7',
    './components/file-manager.html?v=8',
    './components/file-manager.html?v=9',
    './components/file-manager.html?v=10',
    './components/file-manager.html?v=11',
    './components/file-manager.html?v=12',
    './components/file-manager.html?v=13',
    './components/file-manager.html?v=14',
    './components/header.html',
    './components/header.html?v=2',
    './components/header.html?v=3',
    './components/markdown-editor.html',
    './components/markdown-editor.html?v=1',
    './components/markdown-editor.html?v=2',
    './components/markdown-editor.html?v=3',
    './components/markdown-editor.html?v=4',
    './components/markdown-editor.html?v=5',
    './components/markdown-editor.html?v=6',
    './components/modal.html',	
    './components/modal.html?v=3',
    './components/modal.html?v=4',
    './components/modal.html?v=5',
    './components/modal.html?v=6',
    './components/modal.html?v=7',
    './components/modal.html?v=8',
    './components/modal.html?v=9',
    './components/modal.html?v=10',
    './components/modal.html?v=11',
    './components/nav.html',
    './components/nav.html?v=2',
    './components/nav.html?v=3',
    './components/nav.html?v=4',
    './components/nav.html?v=5',
    './components/speech.html',		
    './components/speech.html?v=1',
    './components/table.html',
    './components/voice-transcription.html',
    './components/voice-transcription.html?v=1',
    './components/voice-transcription.html?v=2',
    './components/voice-transcription.html?v=3',
    './components/voice-transcription.html?v=4',
    './components/voice-transcription.html?v=5',
    './components/voice-transcription.html?v=6',
    './boss/components/nav.html?v=1',

    './entities/Chat.js',
    './entities/File.js',
    './entities/Journal.js',
    './entities/Notes.js',
    './entities/Notes.js?v=2',
    './entities/Reports.js',
    './entities/Score.js',
    './entities/Scores.js',
    './entities/StreamOfConsciousness.js',
    './entities/User.js',

    './node_modules/strong-type/index.js',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(urlsToCache);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (!cacheWhitelist.includes(cacheName)) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// Fetch event - serve cached files only when offline
self.addEventListener('fetch', event => {
    try{
        event.respondWith(
            fetch(event.request).catch(() => {
                return caches.match(event.request);
            })
        );
    }catch{
        console.info("[service-worker] fetch failed for ", event.request.url);
    }
});
