/**
 * Gemini Watermark Remover - Core Logic
 */

const STATE = {
    masks: {
        small: null, // { width: 48, height: 48, alphas: Float32Array }
        large: null  // { width: 96, height: 96, alphas: Float32Array }
    },
    originalImage: null,
    processedImageData: null,
    isProcessing: false,
    config: {
        forceMode: 'auto' // 'auto', 'small', 'large'
    }
};

// DOM Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const canvasContainer = document.getElementById('canvasContainer');
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const loadingOverlay = document.getElementById('loadingOverlay');
const sizeSelect = document.getElementById('sizeSelect');
const downloadBtn = document.getElementById('downloadBtn');
const processBtn = document.getElementById('processBtn'); // Acts as Reset

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
            // Convert image to alpha map
            const w = img.width;
            const h = img.height;

            // Draw to a temp canvas to read pixels
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
                // Max of RGB / 255.0
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
// Core Algorithm: Reverse Alpha Blending
// =============================================================================

function removeWatermark(imageData) {
    const w = imageData.width;
    const h = imageData.height;

    // 1. Determine size & config
    let mode = STATE.config.forceMode;
    if (mode === 'auto') {
        if (w > 1024 && h > 1024) {
            mode = 'large';
        } else {
            mode = 'small';
        }
    }

    const mask = mode === 'large' ? STATE.masks.large : STATE.masks.small;
    if (!mask) return; // Should not happen if loaded

    // Config: 
    // Small: 48x48, margin 32
    // Large: 96x96, margin 64
    const margin = mode === 'large' ? 64 : 32;

    // Calculate position (top-left of watermark)
    // x = Width - margin - logoSize
    // y = Height - margin - logoSize
    const posX = w - margin - mask.width;
    const posY = h - margin - mask.height;

    // Check bounds
    if (posX < 0 || posY < 0) return; // Image too small

    // 2. Process Pixels
    const data = imageData.data; // Uint8ClampedArray
    const logoValue = 255.0; // The watermark is white
    const alphaThreshold = 0.002;
    const maxAlpha = 0.99; // Prevent division by zero

    for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
            // Image coordinates
            const iy = posY + my;
            const ix = posX + mx;

            if (ix >= w || iy >= h) continue;

            // Mask index
            const mIdx = my * mask.width + mx;
            let alpha = mask.alphas[mIdx];

            if (alpha < alphaThreshold) continue;

            // Clamp alpha
            if (alpha > maxAlpha) alpha = maxAlpha;

            const oneMinusAlpha = 1.0 - alpha;

            // Image data index (4 channels per pixel)
            const idx = (iy * w + ix) * 4;

            // RGB Channels
            for (let c = 0; c < 3; c++) {
                const currentVal = data[idx + c];
                // Formula: Original = (Result - Alpha * Logo) / (1 - Alpha)
                let original = (currentVal - alpha * logoValue) / oneMinusAlpha;

                // Clamp result
                if (original < 0) original = 0;
                if (original > 255) original = 255;

                data[idx + c] = original;
            }
            // Alpha channel (data[idx+3]) remains unchanged (usually 255)
        }
    }

    return imageData;
}

// =============================================================================
// UI Logic & Event Handlers
// =============================================================================

function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            STATE.originalImage = img;
            processAndRender();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function processAndRender() {
    if (!STATE.originalImage) return;

    // Show Loading
    loadingOverlay.style.display = 'flex';
    canvasContainer.classList.add('active');

    // Delay slightly to let UI update
    setTimeout(() => {
        const img = STATE.originalImage;

        // Reset canvas size
        canvas.width = img.width;
        canvas.height = img.height;

        // Draw original
        ctx.drawImage(img, 0, 0);

        // Get Pixel Data
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Apply Watermark Removal
        removeWatermark(imageData); // Modified in-place

        // Put back
        ctx.putImageData(imageData, 0, 0);

        // Save state
        STATE.processedImageData = imageData;

        // UI Updates
        loadingOverlay.style.display = 'none';
        downloadBtn.disabled = false;
        processBtn.disabled = false;
        dropZone.style.display = 'none'; // Hide drop zone to show canvas

    }, 50);
}

function reset() {
    STATE.originalImage = null;
    STATE.processedImageData = null;
    canvas.width = 0;
    canvas.height = 0;

    canvasContainer.classList.remove('active');
    dropZone.style.display = 'block';
    downloadBtn.disabled = true;
    processBtn.disabled = true;
    fileInput.value = '';
}

// Compare Feature (Hold to see original)
canvasContainer.addEventListener('mousedown', () => {
    if (!STATE.originalImage) return;
    ctx.drawImage(STATE.originalImage, 0, 0);
});

canvasContainer.addEventListener('mouseup', () => {
    if (!STATE.processedImageData) return;
    ctx.putImageData(STATE.processedImageData, 0, 0);
});

canvasContainer.addEventListener('mouseleave', () => {
    // If user leaves while holding click, restore processed
    if (!STATE.processedImageData) return;
    ctx.putImageData(STATE.processedImageData, 0, 0);
});

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
        handleFile(e.dataTransfer.files[0]);
    }
});

dropZone.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

// Controls
sizeSelect.addEventListener('change', (e) => {
    STATE.config.forceMode = e.target.value;
    if (STATE.originalImage) {
        processAndRender(); // Reprocess immediately
    }
});

processBtn.addEventListener('click', reset);

downloadBtn.addEventListener('click', () => {
    if (!STATE.processedImageData) return;

    // Use toBlob instead of toDataURL for better support of large images
    canvas.toBlob((blob) => {
        if (!blob) {
            console.error('Canvas toBlob failed');
            alert('Error generating image file.');
            return;
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = 'cleaned_image.png';
        link.href = url;
        link.click();

        // Clean up memory
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
});

// Init
init();
