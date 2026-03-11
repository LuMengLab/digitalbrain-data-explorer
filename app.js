// Main Application - Initializes and coordinates all modules

// Event Listeners
function initializeEventListeners() {
    // Collection selector
    document.getElementById('collectionSelect').addEventListener('change', (e) => {
        const collectionId = e.target.value;
        populateDatasets(collectionId);
    });

    // Dataset selector
    document.getElementById('datasetSelect').addEventListener('change', (e) => {
        const collectionId = document.getElementById('collectionSelect').value;
        const datasetId = e.target.value;
        populateDonors(collectionId, datasetId);
    });

    // Donor selector
    document.getElementById('donorSelect').addEventListener('change', (e) => {
        const collectionId = document.getElementById('collectionSelect').value;
        const datasetId = document.getElementById('datasetSelect').value;
        const donorId = e.target.value;
        updateView(collectionId, datasetId, donorId);
    });

    document.getElementById('cellMetricPrimaryBtn').addEventListener('click', () => switchCellMetric('composition'));
    document.getElementById('cellMetricSecondaryBtn').addEventListener('click', () => switchCellMetric('diversity'));
    document.getElementById('cellMetricTertiaryBtn').addEventListener('click', () => switchCellMetric('comparison'));
    document.getElementById('cellRangeTopBtn').addEventListener('click', () => switchCellRange('top'));
    document.getElementById('cellRangeOtherBtn').addEventListener('click', () => switchCellRange('other'));
    document.getElementById('cellRangeAllBtn').addEventListener('click', () => switchCellRange('all'));

    document.getElementById('regionMetricPrimaryBtn').addEventListener('click', () => switchRegionMetric('composition'));
    document.getElementById('regionMetricSecondaryBtn').addEventListener('click', () => switchRegionMetric('coverage'));
    document.getElementById('regionMetricTertiaryBtn').addEventListener('click', () => switchRegionMetric('comparison'));
    document.getElementById('regionRangeTopBtn').addEventListener('click', () => switchRegionRange('top'));
    document.getElementById('regionRangeOtherBtn').addEventListener('click', () => switchRegionRange('other'));
    document.getElementById('regionRangeAllBtn').addEventListener('click', () => switchRegionRange('all'));

    document.addEventListener('click', (event) => {
        const toggle = event.target.closest('.overview-toggle');
        if (!toggle) {
            return;
        }

        toggleOverviewExpansion(toggle.dataset.overview, toggle.dataset.section);
    });
}

// Initialize application
function initializeApp() {
    console.log('Initializing DigitalNeuron Explorer...');
    
    // Validate data structure
    if (!validateDataStructure(currentData)) {
        console.error('Invalid data structure');
        alert('Error: Invalid data structure. Please check the data format.');
        return;
    }

    // Populate initial dropdowns
    populateCollections();
    
    // Set up event listeners
    initializeEventListeners();
    
    // Show initial global aggregated state
    updateView('', '', '');
    
    console.log('DigitalNeuron Explorer initialized successfully');
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    destroyAllCharts();
});

// Error handling
window.addEventListener('error', (event) => {
    console.error('Application error:', event.error);
});

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Export functions to global scope for onclick handlers
window.switchRegionType = switchRegionType;
window.switchCellView = switchCellView;
window.switchCellMetric = switchCellMetric;
window.switchRegionMetric = switchRegionMetric;
window.switchCellRange = switchCellRange;
window.switchRegionRange = switchRegionRange;
