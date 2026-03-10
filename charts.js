// Chart Controller - Handles all Chart.js visualizations

let cellTypeChart = null;
let regionChart = null;

// Color palettes
const chartColors = [
    '#146c94', '#1f8ea8', '#2a9d8f', '#7aa65a', '#d98f3b',
    '#c76b50', '#8e6c88', '#56738a', '#5b8fca', '#4f9fa3',
    '#3b7f6f', '#ba5f4d', '#6f87b8', '#9c7f4f', '#748696',
    '#4f6d7a', '#9a6d38', '#607d8b'
];

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
