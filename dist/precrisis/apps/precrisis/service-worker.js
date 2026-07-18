const CACHE_PREFIX = 'arcane-precrisis-cache-';
const LEGACY_CACHE_PREFIX = 'PreCrisis-cache-';
const CACHE_NAME = `${CACHE_PREFIX}v43`;
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

    '../../arcane/css/layout.css',
    '../../arcane/css/layout.css?v=2',
    '../../arcane/css/layout.css?v=3',
    '../../arcane/css/theme.css?v=1',
    '../../arcane/css/dashboard-config.css',
    '../../arcane/css/dashboard-config.css?v=1',
    '../../arcane/css/dashboard-config.css?v=2',
    
    './img/1024.png',
    './img/512.png',
    './img/256.png',
    './img/192.png',
    '../../arcane/img/arrow-left.png',
    '../../arcane/img/arrow-right.png',
    '../../arcane/img/doc.svg',
    './img/favicon.png',
    '../../arcane/img/folder.svg',
    '../../arcane/img/refresh.png',
    '../../arcane/img/send.svg',
    '../../arcane/img/trash.svg',
    '../../arcane/img/upload.svg',
    
    '../../arcane/modules/AI.js?v=3',
    './modules/AssessmentRecords.js',
    './modules/AssessmentReportRunner.js',
    './modules/AssessmentTools.js',
    '../../arcane/modules/ChatRecords.js',
    '../../arcane/modules/ChartLibrary.js',
    '../../arcane/modules/ComponentContracts.js',
    './modules/CrisisModal.js',
    './modules/DashboardCharts.js',
    './modules/DashboardData.js',
    '../../arcane/modules/DataMaintenance.js',
    '../../arcane/modules/DataMaintenance.js?v=2',
    '../../arcane/modules/DataMaintenance.js?v=3',
    '../../arcane/modules/AppDataScope.js',
    '../../arcane/modules/DBOPFS.js',
    '../../arcane/modules/DBOPFSWorker.js',
    '../../arcane/modules/DBLS.js',
    '../../arcane/modules/Errors.js?v=2',
    '../../arcane/modules/HTMLImport.js',
    '../../arcane/modules/HTMLImport.js?v=2',
    '../../arcane/modules/Mail.js',
    '../../arcane/modules/MailTransport.mjs',
    '../../arcane/modules/MD.js',
    '../../arcane/modules/MD.js?v=2',
    '../../arcane/modules/Marked.min.js',
    '../../arcane/modules/MemoryRecords.js',
    './modules/PostSaveAssessment.js',
    './modules/PostSaveAssessmentUI.js',
    '../../arcane/modules/QRCode.min.js',
    '../../arcane/modules/ToolCallRouter.js',
    '../../arcane/modules/ThemeBootstrap.js?v=1',
    '../../arcane/modules/ThemeManager.js',
    '../../arcane/modules/AppearancePreferences.js',
    '../../arcane/modules/PreferenceStore.js',
    '../../arcane/modules/uPlot.iife.min.js',
    '../../arcane/modules/uPlot.min.css',
    '../../arcane/modules/WaitForComponent.js',
    
    '../../arcane/components/chat.html',
    '../../arcane/components/chat.html?v=3',
    '../../arcane/components/chart.html',
    '../../arcane/components/chart.html?v=1',
    '../../arcane/components/chart.html?v=2',
    '../../arcane/components/chart.html?v=3',
    '../../arcane/components/chart.html?v=4',
    '../../arcane/components/chart.html?v=5',
    '../../arcane/components/dashboard-config.html',
    '../../arcane/components/dashboard-config.html?v=1',
    '../../arcane/components/dashboard-config.html?v=2',
    '../../arcane/components/dashboard-config.html?v=3',
    '../../arcane/components/dashboard-config.html?v=4',
    '../../arcane/components/data-maintenance.html',
    '../../arcane/components/data-maintenance.html?v=1',
    '../../arcane/components/data-maintenance.html?v=2',
    '../../arcane/components/data-maintenance.html?v=3',
    '../../arcane/components/data-view.html',
    '../../arcane/components/data-view.html?v=1',
    '../../arcane/components/data-view.html?v=2',
    '../../arcane/components/data-view.html?v=3',
    '../../arcane/components/data-view.html?v=4',
    '../../arcane/components/file-manager.html',
    '../../arcane/components/file-manager.html?v=2',
    '../../arcane/components/file-manager.html?v=3',
    '../../arcane/components/file-manager.html?v=4',
    '../../arcane/components/file-manager.html?v=5',
    '../../arcane/components/file-manager.html?v=6',
    '../../arcane/components/file-manager.html?v=7',
    '../../arcane/components/file-manager.html?v=8',
    '../../arcane/components/file-manager.html?v=9',
    '../../arcane/components/file-manager.html?v=10',
    '../../arcane/components/file-manager.html?v=11',
    '../../arcane/components/file-manager.html?v=12',
    '../../arcane/components/file-manager.html?v=13',
    '../../arcane/components/file-manager.html?v=14',
    '../../arcane/components/file-manager.html?v=15',
    '../../arcane/components/file-manager.html?v=16',
    '../../arcane/components/file-manager.html?v=17',
    '../../arcane/components/file-manager.html?v=18',
    '../../arcane/components/header.html',
    '../../arcane/components/header.html?v=2',
    '../../arcane/components/header.html?v=3',
    '../../arcane/components/markdown-editor.html',
    '../../arcane/components/markdown-editor.html?v=1',
    '../../arcane/components/markdown-editor.html?v=2',
    '../../arcane/components/markdown-editor.html?v=3',
    '../../arcane/components/markdown-editor.html?v=4',
    '../../arcane/components/markdown-editor.html?v=5',
    '../../arcane/components/markdown-editor.html?v=6',
    '../../arcane/components/markdown-editor.html?v=7',
    '../../arcane/components/markdown-editor.html?v=8',
    '../../arcane/components/modal.html',
    '../../arcane/components/modal.html?v=3',
    '../../arcane/components/modal.html?v=4',
    '../../arcane/components/modal.html?v=5',
    '../../arcane/components/modal.html?v=6',
    '../../arcane/components/modal.html?v=7',
    '../../arcane/components/modal.html?v=8',
    '../../arcane/components/modal.html?v=9',
    '../../arcane/components/modal.html?v=10',
    '../../arcane/components/modal.html?v=11',
    '../../arcane/components/modal.html?v=12',
    '../../arcane/components/modal.html?v=13',
    './components/nav.html',
    './components/nav.html?v=2',
    './components/nav.html?v=3',
    './components/nav.html?v=4',
    './components/nav.html?v=5',
    '../../arcane/components/speech.html',
    '../../arcane/components/speech.html?v=1',
    '../../arcane/components/table.html',
    '../../arcane/components/voice-transcription.html',
    '../../arcane/components/voice-transcription.html?v=1',
    '../../arcane/components/voice-transcription.html?v=2',
    '../../arcane/components/voice-transcription.html?v=3',
    '../../arcane/components/voice-transcription.html?v=4',
    '../../arcane/components/voice-transcription.html?v=5',
    '../../arcane/components/voice-transcription.html?v=6',
    '../../arcane/components/voice-transcription.html?v=7',
    '../../arcane/components/voice-transcription.html?v=8',
    '../../arcane/entities/Chat.js',
    '../../arcane/entities/File.js',
    '../../arcane/entities/Preference.js',
    '../../arcane/entities/Theme.js',
    './entities/Journal.js',
    './entities/Notes.js',
    './entities/Notes.js?v=2',
    './entities/Reports.js',
    './entities/Score.js',
    './entities/Scores.js',
    './entities/StreamOfConsciousness.js',
    '../../arcane/entities/User.js',

    '../../node_modules/strong-type/index.js',
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
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    const belongsToPreCrisis = cacheName.startsWith(CACHE_PREFIX)
                        || cacheName.startsWith(LEGACY_CACHE_PREFIX);
                    if (belongsToPreCrisis && cacheName !== CACHE_NAME) {
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
                return caches.open(CACHE_NAME).then(
                    cache => cache.match(event.request)
                );
            })
        );
    }catch{
        console.info("[service-worker] fetch failed for ", event.request.url);
    }
});
