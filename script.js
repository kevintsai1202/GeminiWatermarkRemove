/**
 * Gemini Watermark Remover - Batch Processing
 */

const STATE = {
    masks: {
        small: null, // { width: 48, height: 48, alphas: Float32Array }
        large: null  // { width: 96, height: 96, alphas: Float32Array }
    },
    processors: [] // Store active ImageProcessor instances
};

// Global DOM Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const resultsContainer = document.getElementById('resultsContainer');
const globalActions = document.getElementById('globalActions');
const downloadAllBtn = document.getElementById('downloadAllBtn');

// =============================================================================
// Initialization & Asset Loading
// =============================================================================

async function init() {
    try {
        await Promise.all([
            loadMask('assets/mask_48.png', 'small'),
            loadMask('assets/mask_96.png', 'large')
        ]);
        console.log('Masks loaded successfully');
    } catch (e) {
        console.error('Failed to load masks:', e);
        alert('Failed to load watermark assets. Please check the console.');
    }
}

function loadMask(url, type) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = url;
        img.onload = () => {
            const w = img.width;
            const h = img.height;
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tCtx = tempCanvas.getContext('2d');
            tCtx.drawImage(img, 0, 0);

            const imageData = tCtx.getImageData(0, 0, w, h);
            const data = imageData.data;
            const alphas = new Float32Array(w * h);

            for (let i = 0; i < w * h; i++) {
                const r = data[i * 4];
                const g = data[i * 4 + 1];
                const b = data[i * 4 + 2];
                const maxVal = Math.max(r, Math.max(g, b));
                alphas[i] = maxVal / 255.0;
            }

            STATE.masks[type] = { width: w, height: h, alphas };
            resolve();
        };
        img.onerror = reject;
    });
}

// =============================================================================
// Image Processor Class (Per Image Logic)
// =============================================================================

class ImageProcessor {
    constructor(file) {
        this.file = file;
        this.id = Math.random().toString(36).substr(2, 9);
        this.config = {
            forceMode: 'auto',
            alphaGain: 1.0
        };
        this.state = {
            originalImage: null,
            processedImageData: null,
            isProcessing: false
        };

        // UI Elements
        this.elements = {};

        this.init();
    }

    init() {
        this.createUI();
        this.loadImage();
    }

    createUI() {
        const card = document.createElement('div');
        card.className = 'image-card';
        card.innerHTML = `
            <div class="image-wrapper">
                <canvas></canvas>
                <div class="loading-overlay">
                    <div class="spinner"></div>
                </div>
                <div class="comparison-overlay">長按對比原圖</div>
            </div>
            
            <div class="card-controls">
                <div class="card-options">
                    <div class="control-group">
                        <select aria-label="浮水印大小">
                            <option value="auto">自動偵測大小</option>
                            <option value="small">強制小尺寸 (48px)</option>
                            <option value="large">強制大尺寸 (96px)</option>
                        </select>
                    </div>
                    <div class="control-group slider-group">
                        <label>強度調整: <span class="alpha-value">1.0</span></label>
                        <input type="range" min="1.0" max="3.0" step="0.1" value="1.0">
                    </div>
                </div>

                <div class="actions" style="display: flex; gap: 1rem;">
                    <button class="btn btn-secondary remove-btn" title="移除圖片">
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                    <button class="btn btn-primary download-btn" disabled>
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                        </svg>
                        下載
                    </button>
                </div>
            </div>
            <div style="text-align: center; color: var(--text-secondary); font-size: 0.9rem;">
                ${this.file.name}
            </div>
        `;

        // Store references
        this.elements.card = card;
        this.elements.canvas = card.querySelector('canvas');
        this.elements.ctx = this.elements.canvas.getContext('2d', { willReadFrequently: true });
        this.elements.loading = card.querySelector('.loading-overlay');
        this.elements.sizeSelect = card.querySelector('select');
        this.elements.alphaInput = card.querySelector('input[type="range"]');
        this.elements.alphaValue = card.querySelector('.alpha-value');
        this.elements.downloadBtn = card.querySelector('.download-btn');
        this.elements.removeBtn = card.querySelector('.remove-btn');
        this.elements.wrapper = card.querySelector('.image-wrapper');

        // Bind Events
        this.elements.sizeSelect.addEventListener('change', (e) => {
            this.config.forceMode = e.target.value;
            this.processAndRender();
        });

        this.elements.alphaInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.config.alphaGain = val;
            this.elements.alphaValue.textContent = val.toFixed(2);
            this.processAndRender();
        });

        this.elements.downloadBtn.addEventListener('click', () => this.download());
        this.elements.removeBtn.addEventListener('click', () => this.destroy());

        // Comparison interactions
        const startCompare = (e) => {
            if (e && e.cancelable) e.preventDefault();
            if (!this.state.originalImage) return;
            this.elements.ctx.drawImage(this.state.originalImage, 0, 0);
        };

        const endCompare = () => {
            if (!this.state.processedImageData) return;
            this.elements.ctx.putImageData(this.state.processedImageData, 0, 0);
        };

        // Interaction Logic: Click vs Long Press
        let pressTimer;
        let isLongPress = false;
        const longPressDuration = 250; // ms

        const startPress = (e) => {
            // Only left click or touch
            if (e.type === 'mousedown' && e.button !== 0) return;

            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                startCompare(e); // Trigger comparison
            }, longPressDuration);
        };

        const endPress = (e) => {
            clearTimeout(pressTimer);

            if (isLongPress) {
                // Was a long press -> End comparison
                endCompare();
            } else {
                // Was a short click -> Open Lightbox
                console.log('Short click detected, opening lightbox');
                if (typeof Lightbox !== 'undefined') {
                    Lightbox.open(this.state.processedImageData, this.state.originalImage);
                } else {
                    console.error('Lightbox is undefined');
                }
            }
            isLongPress = false;
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
            if (isLongPress) endCompare();
            isLongPress = false;
        };

        // prevent context menu on mobile
        this.elements.wrapper.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        };

        this.elements.wrapper.addEventListener('mousedown', startPress);
        this.elements.wrapper.addEventListener('touchstart', (e) => {
            // e.preventDefault(); // Might block scrolling? Test carefully.
            // Usually better not to preventDefault on start unless we handle scroll
            startPress(e);
        }, { passive: true });

        this.elements.wrapper.addEventListener('mouseup', endPress);
        this.elements.wrapper.addEventListener('touchend', endPress);

        this.elements.wrapper.addEventListener('mouseleave', cancelPress);
        // touchcancel?

        // Append to DOM
        resultsContainer.appendChild(card);

        // Update UI State
        updateUIState();
    }

    loadImage() {
        if (!this.file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.state.originalImage = img;
                this.processAndRender();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(this.file);
    }

    processAndRender() {
        if (!this.state.originalImage) return;

        // Show Loading
        this.elements.loading.style.display = 'flex';

        setTimeout(() => {
            const img = this.state.originalImage;
            const canvas = this.elements.canvas;

            // Set canvas size
            canvas.width = img.width;
            canvas.height = img.height;

            // Draw original
            this.elements.ctx.drawImage(img, 0, 0);

            // Get Data
            const imageData = this.elements.ctx.getImageData(0, 0, canvas.width, canvas.height);

            // Remove Watermark
            this.removeWatermark(imageData);

            // Put Back
            this.elements.ctx.putImageData(imageData, 0, 0);

            // Update State
            this.state.processedImageData = imageData;
            this.elements.loading.style.display = 'none';
            this.elements.downloadBtn.disabled = false;

        }, 50);
    }

    removeWatermark(imageData) {
        const w = imageData.width;
        const h = imageData.height;

        // 1. Determine configuration
        let mode = this.config.forceMode;
        if (mode === 'auto') {
            if (w > 1024 && h > 1024) {
                mode = 'large';
            } else {
                mode = 'small';
            }
        }

        const mask = mode === 'large' ? STATE.masks.large : STATE.masks.small;
        if (!mask) return;

        const margin = mode === 'large' ? 64 : 32;
        const posX = w - margin - mask.width;
        const posY = h - margin - mask.height;

        if (posX < 0 || posY < 0) return;

        // 2. Process
        const data = imageData.data;
        const logoValue = 255.0;
        const alphaThreshold = 0.002;
        const maxAlpha = 0.99;
        const gain = this.config.alphaGain;

        for (let my = 0; my < mask.height; my++) {
            for (let mx = 0; mx < mask.width; mx++) {
                const iy = posY + my;
                const ix = posX + mx;

                if (ix >= w || iy >= h) continue;

                const mIdx = my * mask.width + mx;
                let alpha = mask.alphas[mIdx] * gain;

                if (alpha < alphaThreshold) continue;
                if (alpha > maxAlpha) alpha = maxAlpha;

                const oneMinusAlpha = 1.0 - alpha;
                const idx = (iy * w + ix) * 4;

                for (let c = 0; c < 3; c++) {
                    const currentVal = data[idx + c];
                    let original = (currentVal - alpha * logoValue) / oneMinusAlpha;
                    if (original < 0) original = 0;
                    if (original > 255) original = 255;
                    data[idx + c] = original;
                }
            }
        }
    }

    download() {
        if (!this.state.processedImageData) return;
        this.elements.canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            // Suggest filename: "original_clean.png"
            const nameParts = this.file.name.split('.');
            nameParts.pop(); // remove extension
            link.download = `${nameParts.join('.')}_clean.png`;
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
    }

    destroy() {
        // Remove from UI
        this.elements.card.remove();

        // Remove from Global List
        STATE.processors = STATE.processors.filter(p => p !== this);

        // Update UI State
        updateUIState();
    }
}

// =============================================================================
// Global Event Handlers
// =============================================================================

function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    Array.from(fileList).forEach(file => {
        if (file.type.startsWith('image/')) {
            const processor = new ImageProcessor(file);
            STATE.processors.push(processor);
        }
    });

    // Reset file input so same file can be selected again if needed
    fileInput.value = '';

    updateUIState();
}

function updateUIState() {
    if (STATE.processors.length > 0) {
        document.body.classList.add('has-files');
        globalActions.style.display = 'flex';
    } else {
        document.body.classList.remove('has-files');
        globalActions.style.display = 'none';
    }
}

// Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
    }
});



dropZone.addEventListener('click', (e) => {
    // Prevent file dialog if clicking on results
    if (e.target.closest('.results-container')) return;
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

// Download All
downloadAllBtn.addEventListener('click', () => {
    let delay = 0;
    STATE.processors.forEach(p => {
        // Stagger downloads to prevent browser blocking
        setTimeout(() => {
            p.download();
        }, delay);
        delay += 300;
    });
});

// =============================================================================
// Lightbox Controller
// =============================================================================
const Lightbox = {
    elements: {
        modal: document.getElementById('lightbox'),
        img: document.getElementById('lightboxImage'),
        close: document.querySelector('.lightbox-close')
    },
    activeOriginal: null,
    activeProcessed: null,

    init() {
        console.log('Lightbox initializing, modal found:', !!this.elements.modal);
        if (!this.elements.modal) return;

        this.elements.close.onclick = () => this.close();
        this.elements.modal.onclick = (e) => {
            if (e.target === this.elements.modal) this.close();
        };

        // Escape to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.elements.modal.style.display === 'flex') {
                this.close();
            }
        });

        // Long Press comparison in Lightbox
        const start = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return;
            if (this.activeOriginal) {
                this.elements.img.src = this.activeOriginal.src;
            }
        };
        const end = (e) => {
            if (this.activeProcessed) {
                this.elements.img.src = this.activeProcessed;
            }
        };

        this.elements.img.addEventListener('mousedown', start);
        this.elements.img.addEventListener('touchstart', start);
        this.elements.img.addEventListener('mouseup', end);
        this.elements.img.addEventListener('touchend', end);
        this.elements.img.addEventListener('mouseleave', end);
    },

    open(processedImageData, originalImage) {
        if (!processedImageData || !originalImage) return;

        // Clone/Store original
        this.activeOriginal = originalImage;

        // Convert Processed ImageData to DataURL for <img>
        const canvas = document.createElement('canvas');
        canvas.width = processedImageData.width;
        canvas.height = processedImageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(processedImageData, 0, 0);
        this.activeProcessed = canvas.toDataURL();

        // Set content
        this.elements.img.src = this.activeProcessed;
        this.elements.modal.style.display = 'flex';
    },

    close() {
        this.elements.modal.style.display = 'none';
        this.elements.img.src = '';
        this.activeOriginal = null;
        this.activeProcessed = null;
    }
};

// Init
init();
// Initialize Lightbox
Lightbox.init();
