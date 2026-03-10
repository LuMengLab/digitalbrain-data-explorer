// UI Controller - Handles DOM updates and delegates aggregation to data-model.js

const dataModel = window.DigitalNeuronModel;
const DISPLAY_NAME_ALIASES = {
    'DigitaiBrain-Data': 'DigitalBrain Data',
};
const OVERVIEW_BADGE_LIMIT = 3;
const OVERVIEW_REGION_LIMIT = 3;
let currentSelection = {
    collectionId: '',
    datasetId: '',
    donorId: '',
};

function getSelection() {
    return { ...currentSelection };
}

function setSelection(collectionId, datasetId, donorId) {
    currentSelection = {
        collectionId: collectionId || '',
        datasetId: datasetId || '',
        donorId: donorId || '',
    };
}

function getScopeState(collectionId, datasetId, donorId) {
    return dataModel.computeScopeState(currentData, collectionId, datasetId, donorId);
}

function formatStatusClass(status) {
    return `status-${String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function formatDisplayName(name) {
    return DISPLAY_NAME_ALIASES[name] || name;
}

function getScopeLabel(scope) {
    return formatDisplayName(scope.scopeLabel);
}

function buildBadges(statuses, limit = null) {
    if (!statuses.length) {
        return '<span class="status-badge status-muted">No disease labels</span>';
    }

    const visibleStatuses = limit ? statuses.slice(0, limit) : statuses;
    const badges = visibleStatuses
        .map((status) => `<span class="status-badge ${formatStatusClass(status)}">${status}</span>`);

    if (limit && statuses.length > limit) {
        badges.push(`<span class="status-badge status-overflow">+${statuses.length - limit} more</span>`);
    }

    return badges.join('');
}

function formatCondensedList(items, limit) {
    if (!items.length) {
        return 'None';
    }

    const visibleItems = items.slice(0, limit);
    const remainingCount = items.length - visibleItems.length;
    return remainingCount > 0
        ? `${visibleItems.join(', ')} <span class="summary-more">+${remainingCount} more</span>`
        : visibleItems.join(', ');
}

function buildRegionsSummary(scope, limit = OVERVIEW_REGION_LIMIT) {
    const brodmann = formatCondensedList(scope.brodmannRegions, limit);
    const gyral = formatCondensedList(scope.gyralRegions, limit);
    return [
        `<div class="summary-line"><strong>Brodmann Areas</strong><span>${brodmann}</span></div>`,
        `<div class="summary-line"><strong>Gyral Regions</strong><span>${gyral}</span></div>`,
    ].join('');
}

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function populateCollections() {
    const collectionSelect = document.getElementById('collectionSelect');
    collectionSelect.innerHTML = '<option value="">Select Collection</option>';

    dataModel.getCollections(currentData).forEach(({ id, name }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = `${id}: ${formatDisplayName(name)}`;
        collectionSelect.appendChild(option);
    });
}

function populateDatasets(collectionId) {
    const datasetSelect = document.getElementById('datasetSelect');
    const donorSelect = document.getElementById('donorSelect');

    datasetSelect.innerHTML = '<option value="">Select Dataset</option>';
    donorSelect.innerHTML = '<option value="">Select Donor</option>';

    if (!collectionId) {
        datasetSelect.disabled = true;
        donorSelect.disabled = true;
        updateView('', '', '');
        return;
    }

    dataModel.getDatasets(currentData, collectionId).forEach(({ id, name }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = formatDisplayName(name);
        datasetSelect.appendChild(option);
    });

    datasetSelect.disabled = false;
    donorSelect.disabled = true;
    updateView(collectionId, '', '');
}

function populateDonors(collectionId, datasetId) {
    const donorSelect = document.getElementById('donorSelect');
    donorSelect.innerHTML = '<option value="">Select Donor</option>';

    if (!collectionId || !datasetId) {
        donorSelect.disabled = true;
        updateView(collectionId, '', '');
        return;
    }

    dataModel.getDonorOptions(currentData, collectionId, datasetId).forEach(({ id, label }) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        donorSelect.appendChild(option);
    });

    donorSelect.disabled = false;
    updateView(collectionId, datasetId, '');
}

function hideAllSections() {
    document.getElementById('collectionOverview').classList.add('hidden');
    document.getElementById('datasetOverview').classList.add('hidden');
    document.getElementById('donorDetails').classList.add('hidden');
    document.getElementById('cellTypeSection').classList.add('hidden');
    document.getElementById('brainRegionsSection').classList.add('hidden');
}

function renderScopeBanner(scope) {
    const scopeLabel = getScopeLabel(scope);
    const scopeTitleMap = {
        global: 'All Collections',
        collection: scopeLabel,
        dataset: scopeLabel,
        donor: scope.scopeLabel,
    };
    const subtitleMap = {
        global: 'Global overview across every collection in the explorer.',
        collection: 'Collection-wide summary across all datasets and donors.',
        dataset: 'Dataset-level view with aggregated donor statistics and region composition.',
        donor: 'Single donor view with normalized metadata, cell types, and brain-region counts.',
    };

    setText('scopeEyebrow', `Current Scope · ${scope.scopeKey.toUpperCase()}`);
    setText('scopeTitle', scopeTitleMap[scope.scopeKey]);
    setText('scopeSubtitle', subtitleMap[scope.scopeKey]);
    setText('scopeDatasets', scope.metrics.datasets.toLocaleString());
    setText('scopeDonors', scope.metrics.donors.toLocaleString());
    setText('scopeCells', scope.metrics.cells.toLocaleString());
}

function renderCollectionOverview(scope, title) {
    const scopeLabel = getScopeLabel(scope);
    setText('collectionOverviewTitle', title.replace(scope.scopeLabel, scopeLabel));
    setText('collectionDatasets', scope.metrics.datasets.toLocaleString());
    setText('collectionDonors', scope.metrics.donors.toLocaleString());
    setText('collectionCells', scope.metrics.cells.toLocaleString());
    setText('collectionRegionsBrod', scope.metrics.brodmannRegions.toLocaleString());
    setText('collectionRegionsGyral', scope.metrics.gyralRegions.toLocaleString());
    document.getElementById('collectionStatuses').innerHTML = buildBadges(scope.statuses, OVERVIEW_BADGE_LIMIT);
    document.getElementById('collectionRegionsSummary').innerHTML = buildRegionsSummary(scope);
    document.getElementById('collectionOverview').classList.remove('hidden');
}

function renderDatasetOverview(scope) {
    setText('datasetOverviewTitle', `Dataset Overview · ${getScopeLabel(scope)}`);
    setText('datasetDonors', scope.metrics.donors.toLocaleString());
    setText('datasetCells', scope.metrics.cells.toLocaleString());
    document.getElementById('datasetStatuses').innerHTML = buildBadges(scope.statuses, OVERVIEW_BADGE_LIMIT);
    document.getElementById('datasetRegionsSummary').innerHTML = buildRegionsSummary(scope);
    document.getElementById('datasetOverview').classList.remove('hidden');
}

function renderDonorDetails(scope) {
    const donor = scope.donors[0];
    if (!donor) {
        document.getElementById('donorDetails').classList.add('hidden');
        return;
    }

    setText('donorDetailsTitle', `Donor Details · ${donor.name}`);
    setText('donorName', donor.name);
    setText('donorAge', `Age: ${donor.age?.[0] || 'N/A'}`);
    setText('donorGender', `Gender: ${donor.gender?.[0] || 'N/A'}`);
    setText('donorCellsDisplay', `${Number(donor.cells || 0).toLocaleString()} cells`);
    document.getElementById('donorStatusBadges').innerHTML = buildBadges(donor.status || []);
    document.getElementById('donorDetails').classList.remove('hidden');
}

function renderCellTypeTable(cellTypeCounts, totalCells) {
    const tableView = document.getElementById('cellTableView');
    const rows = Object.entries(cellTypeCounts)
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1]);

    if (!rows.length) {
        tableView.innerHTML = '<div class="no-data">No cell type data available</div>';
        return;
    }

    tableView.innerHTML = rows.map(([cellType, count]) => {
        const percentage = totalCells ? ((count / totalCells) * 100).toFixed(1) : '0.0';
        return `
            <div class="cell-row">
                <span class="cell-type-name">${cellType}</span>
                <div>
                    <span class="cell-count">${count.toLocaleString()}</span>
                    <span class="cell-percentage">(${percentage}%)</span>
                </div>
            </div>
        `;
    }).join('');
}

function renderCellTypeSection(scope) {
    const totalCells = scope.metrics.cells;
    const hasData = Object.keys(scope.cellTypeCounts).length > 0;
    if (!hasData) {
        document.getElementById('cellTypeSection').classList.add('hidden');
        destroyCellTypeChart();
        return;
    }

    setText('cellTypeTitle', `Cell Type Distribution · ${scope.scopeLabel}`);
    document.getElementById('cellTypeSection').classList.remove('hidden');
    if (currentCellView === 'chart') {
        renderCellTypeChart(scope.cellTypeCounts, totalCells);
    } else {
        renderCellTypeTable(scope.cellTypeCounts, totalCells);
    }
}

function renderRegionTable(counts, totalCells) {
    const rows = Object.entries(counts)
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1]);

    if (!rows.length) {
        document.getElementById('regionsTable').innerHTML = '<div class="no-data">No region data available</div>';
        destroyRegionChart();
        return;
    }

    document.getElementById('regionsTable').innerHTML = rows.map(([region, count]) => {
        const percentage = totalCells ? ((count / totalCells) * 100).toFixed(1) : '0.0';
        return `
            <div class="region-row">
                <span class="region-name">${region}</span>
                <div>
                    <span class="region-count">${count.toLocaleString()}</span>
                    <span class="region-percentage">(${percentage}%)</span>
                </div>
            </div>
        `;
    }).join('');
}

function renderBrainRegions(scope) {
    const counts = currentRegionType === 'brodmann' ? scope.brodCounts : scope.gyralCounts;
    const totalCells = Object.values(counts).reduce((sum, count) => sum + count, 0);

    setText('regionsTitle', `Brain Region Distribution · ${scope.scopeLabel}`);
    document.getElementById('brainRegionsSection').classList.remove('hidden');
    renderRegionTable(counts, totalCells);

    const chartData = Object.entries(counts)
        .filter(([, count]) => count > 0)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 12);

    if (!chartData.length) {
        destroyRegionChart();
        return;
    }

    document.getElementById('regionChartView').classList.remove('hidden');
    renderRegionBarChart(chartData, totalCells);
}

function updateView(collectionId, datasetId, donorId) {
    setSelection(collectionId, datasetId, donorId);
    hideAllSections();

    const globalScope = getScopeState('', '', '');
    renderScopeBanner(getScopeState(collectionId, datasetId, donorId));

    if (!collectionId) {
        renderCollectionOverview(globalScope, 'Global Overview');
        renderCellTypeSection(globalScope);
        renderBrainRegions(globalScope);
        return;
    }

    const collectionScope = getScopeState(collectionId, '', '');
    renderCollectionOverview(collectionScope, `Collection Overview · ${collectionScope.scopeLabel}`);

    if (!datasetId) {
        renderCellTypeSection(collectionScope);
        renderBrainRegions(collectionScope);
        return;
    }

    const datasetScope = getScopeState(collectionId, datasetId, '');
    renderDatasetOverview(datasetScope);

    if (!donorId) {
        renderCellTypeSection(datasetScope);
        renderBrainRegions(datasetScope);
        return;
    }

    const donorScope = getScopeState(collectionId, datasetId, donorId);
    renderDonorDetails(donorScope);
    renderCellTypeSection(donorScope);
    renderBrainRegions(donorScope);
}

function switchRegionType(type) {
    currentRegionType = type;
    document.getElementById('brodmannBtn').classList.toggle('active', type === 'brodmann');
    document.getElementById('gyralBtn').classList.toggle('active', type === 'gyral');

    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}

function switchCellView(view) {
    currentCellView = view;
    document.getElementById('cellChartBtn').classList.toggle('active', view === 'chart');
    document.getElementById('cellTableBtn').classList.toggle('active', view === 'table');
    document.getElementById('cellChartView').classList.toggle('hidden', view !== 'chart');
    document.getElementById('cellTableView').classList.toggle('hidden', view !== 'table');

    const { collectionId, datasetId, donorId } = getSelection();
    updateView(collectionId, datasetId, donorId);
}
