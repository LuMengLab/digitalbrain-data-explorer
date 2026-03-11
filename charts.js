// Chart Controller - Handles all Chart.js visualizations

let cellTypeChart = null;
let regionChart = null;

// Soft palette aligned with the lighter analytical theme.
const chartColors = [
    'rgba(96, 161, 182, 0.82)',
    'rgba(134, 185, 180, 0.82)',
    'rgba(179, 197, 142, 0.82)',
    'rgba(220, 188, 132, 0.82)',
    'rgba(214, 164, 142, 0.82)',
    'rgba(170, 162, 196, 0.82)',
    'rgba(125, 156, 182, 0.82)',
    'rgba(148, 196, 209, 0.82)',
    'rgba(176, 215, 188, 0.82)',
    'rgba(232, 206, 166, 0.82)'
];

function getSoftChartPalette(count) {
    return Array.from({ length: count }, (_, index) => chartColors[index % chartColors.length]);
}

function buildMetricChartOptions(model) {
    const indexAxis = model.indexAxis || 'x';
    const stacked = Boolean(model.stacked);
    const valueAxis = indexAxis === 'y' ? 'x' : 'y';

    return {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis,
        plugins: {
            legend: {
                display: model.datasets.length > 1,
                position: 'bottom',
                labels: {
                    padding: 14,
                    color: '#42515a',
                    font: {
                        size: 11,
                        weight: '600',
                    },
                },
            },
            tooltip: {
                backgroundColor: 'rgba(248, 251, 253, 0.96)',
                titleColor: '#18303d',
                bodyColor: '#18303d',
                borderColor: 'rgba(20, 108, 148, 0.12)',
                borderWidth: 1,
                padding: 12,
                callbacks: {
                    label(context) {
                        const axisValue = indexAxis === 'y' ? context.parsed.x : context.parsed.y;
                        const rawCount = context.dataset.counts?.[context.dataIndex];
                        if (typeof rawCount === 'number') {
                            return `${context.dataset.label}: ${rawCount.toLocaleString()} cells (${Number(axisValue).toFixed(1)}%)`;
                        }
                        if (typeof axisValue === 'number') {
                            return `${context.dataset.label}: ${axisValue.toLocaleString()}`;
                        }
                        return `${context.dataset.label}: ${axisValue}`;
                    },
                },
            },
        },
        scales: {
            x: {
                stacked,
                beginAtZero: true,
                grid: {
                    color: 'rgba(24, 36, 45, 0.08)',
                },
                ticks: {
                    color: '#61717d',
                    callback(value) {
                        return valueAxis === 'x' ? Number(value).toFixed(0) : value;
                    },
                },
            },
            y: {
                stacked,
                beginAtZero: true,
                grid: {
                    display: indexAxis === 'y' ? false : true,
                    color: 'rgba(24, 36, 45, 0.06)',
                },
                ticks: {
                    color: '#42515a',
                    font: {
                        size: 11,
                        weight: '600',
                    },
                },
            },
        },
    };
}

function normalizeMetricDatasets(datasets) {
    return datasets.map((dataset, index) => ({
        ...dataset,
        backgroundColor: dataset.backgroundColor || chartColors[index % chartColors.length],
        borderColor: dataset.borderColor || chartColors[index % chartColors.length].replace('0.82', '1'),
        borderRadius: 8,
        maxBarThickness: 32,
    }));
}

function renderMetricChart(model, chartId, currentChart, assignChart) {
    const ctx = document.getElementById(chartId);
    if (!ctx) return;

    if (currentChart) {
        currentChart.destroy();
        currentChart = null;
    }

    const chart = new Chart(ctx, {
        type: model.type || 'bar',
        data: {
            labels: model.labels,
            datasets: normalizeMetricDatasets(model.datasets),
        },
        options: buildMetricChartOptions(model),
    });

    assignChart(chart);
}

function renderCellMetricChart(model) {
    renderMetricChart(model, 'cellTypeChart', cellTypeChart, (chart) => {
        cellTypeChart = chart;
    });
}

function renderRegionMetricChart(model) {
    renderMetricChart(model, 'regionChart', regionChart, (chart) => {
        regionChart = chart;
    });
}

function renderCellTypeChart(cellTypeCounts, totalCells) {
    const ctx = document.getElementById('cellTypeChart');
    if (!ctx) return;
    
    // Destroy existing chart
    if (cellTypeChart) {
        cellTypeChart.destroy();
        cellTypeChart = null;
    }

    const filteredCells = Object.entries(cellTypeCounts)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
    
    if (filteredCells.length === 0) {
        return;
    }

    // Take top 15 cell types for better visualization
    const topCells = filteredCells.slice(0, 15);
    const labels = topCells.map(([cellType]) => cellType);
    const data = topCells.map(([, count]) => count);
    const percentages = topCells.map(([, count]) => 
        ((count / totalCells) * 100).toFixed(1)
    );

    cellTypeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Cell Count',
                data: data,
                backgroundColor: chartColors.slice(0, topCells.length),
                borderColor: chartColors.slice(0, topCells.length).map(color => color),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const cellType = context.label;
                            const count = context.parsed.x;
                            const percentage = percentages[context.dataIndex];
                            return `${cellType}: ${count.toLocaleString()} cells (${percentage}%)`;
                        }
                    },
                    backgroundColor: 'rgba(18, 36, 45, 0.92)',
                    titleColor: '#f6fbff',
                    bodyColor: '#f6fbff',
                    padding: 12,
                    displayColors: true
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    },
                    grid: {
                        color: 'rgba(24, 36, 45, 0.08)'
                    }
                },
                y: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            size: 11,
                            weight: '600'
                        }
                    }
                }
            },
            layout: {
                padding: {
                    left: 10,
                    right: 10,
                    top: 10,
                    bottom: 10
                }
            }
        }
    });
}

function renderRegionChart(regionData, totalCells) {
    const ctx = document.getElementById('regionChart');
    if (!ctx) return;

    // Destroy existing chart
    if (regionChart) {
        regionChart.destroy();
        regionChart = null;
    }

    // Take top 10 regions for better visualization
    const topRegions = regionData.slice(0, 10);
    const labels = topRegions.map(([region]) => region);
    const data = topRegions.map(([, count]) => count);
    const percentages = topRegions.map(([, count]) => 
        ((count / totalCells) * 100).toFixed(1)
    );

    regionChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: chartColors.slice(0, topRegions.length),
                borderColor: '#fff',
                borderWidth: 3,
                hoverBorderWidth: 4,
                hoverOffset: 15
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'right',
                    labels: {
                        padding: 15,
                        font: {
                            size: 12
                        },
                        generateLabels: function(chart) {
                            const data = chart.data;
                            if (data.labels.length && data.datasets.length) {
                                return data.labels.map((label, i) => {
                                    const value = data.datasets[0].data[i];
                                    const percentage = percentages[i];
                                    return {
                                        text: `${label}: ${percentage}%`,
                                        fillStyle: data.datasets[0].backgroundColor[i],
                                        hidden: false,
                                        index: i
                                    };
                                });
                            }
                            return [];
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const region = context.label;
                            const count = context.parsed;
                            const percentage = percentages[context.dataIndex];
                            return `${region}: ${count.toLocaleString()} cells (${percentage}%)`;
                        }
                    },
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 12
                }
            },
            layout: {
                padding: {
                    left: 10,
                    right: 10,
                    top: 10,
                    bottom: 10
                }
            },
            cutout: '50%',
            animation: {
                animateRotate: true,
                animateScale: true
            }
        }
    });
}

function renderRegionBarChart(regionData, totalCells) {
    const ctx = document.getElementById('regionChart');
    if (!ctx) return;

    // Destroy existing chart
    if (regionChart) {
        regionChart.destroy();
        regionChart = null;
    }

    // Use provided regionData (already sorted) and take top 10
    const topRegions = regionData.slice(0, 10);
    const labels = topRegions.map(([region]) => region);
    const data = topRegions.map(([, count]) => count);
    const percentages = topRegions.map(([, count]) => ((count / totalCells) * 100).toFixed(1));

    regionChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Region Count',
                data: data,
                backgroundColor: chartColors.slice(0, topRegions.length),
                borderColor: chartColors.slice(0, topRegions.length),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const region = context.label;
                            const count = context.parsed.x;
                            const percentage = percentages[context.dataIndex];
                            return `${region}: ${count.toLocaleString()} cells (${percentage}%)`;
                        }
                    },
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 10
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    ticks: { callback: v => v.toLocaleString() },
                    grid: { color: 'rgba(24, 36, 45, 0.08)' }
                },
                y: { grid: { display: false }, ticks: { font: { size: 11, weight: '600' } } }
            }
        }
    });
}

function destroyRegionChart() {
    if (regionChart) {
        regionChart.destroy();
        regionChart = null;
    }
}

function destroyCellTypeChart() {
    if (cellTypeChart) {
        cellTypeChart.destroy();
        cellTypeChart = null;
    }
}

// Cleanup function
function destroyAllCharts() {
    destroyRegionChart();
    destroyCellTypeChart();
}
