// Reusable data table component with sorting, filtering, and pagination

/**
 * Return a relative time string like "2m ago", "1h ago", "3d ago"
 */
export function timeAgo(dateString) {
    if (!dateString) return '-';
    const now = new Date();
    const date = new Date(dateString);
    const diffMs = now - date;

    if (isNaN(diffMs)) return dateString;

    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;

    const years = Math.floor(months / 12);
    return `${years}y ago`;
}

/**
 * Render a sortable, searchable, paginated data table.
 *
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {Array} options.columns - [{ key, label, render? }]
 * @param {Array} options.data - array of row objects
 * @param {Function} [options.onRowClick] - callback(row)
 * @param {number} [options.pageSize=25]
 */
export function renderDataTable(container, { columns, data, onRowClick, pageSize = 25 }) {
    let sortKey = null;
    let sortDir = 'asc';
    let searchTerm = '';
    let currentPage = 0;

    function getFilteredData() {
        if (!searchTerm) return data;
        const term = searchTerm.toLowerCase();
        return data.filter(row =>
            columns.some(col => {
                const val = row[col.key];
                return val != null && String(val).toLowerCase().includes(term);
            })
        );
    }

    function getSortedData(filtered) {
        if (!sortKey) return filtered;
        return [...filtered].sort((a, b) => {
            let va = a[sortKey];
            let vb = b[sortKey];
            if (va == null) va = '';
            if (vb == null) vb = '';
            if (typeof va === 'number' && typeof vb === 'number') {
                return sortDir === 'asc' ? va - vb : vb - va;
            }
            const sa = String(va).toLowerCase();
            const sb = String(vb).toLowerCase();
            if (sa < sb) return sortDir === 'asc' ? -1 : 1;
            if (sa > sb) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
    }

    function escapeHtml(str) {
        if (str == null) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function render() {
        const filtered = getFilteredData();
        const sorted = getSortedData(filtered);
        const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));

        if (currentPage >= totalPages) currentPage = totalPages - 1;
        if (currentPage < 0) currentPage = 0;

        const start = currentPage * pageSize;
        const pageData = sorted.slice(start, start + pageSize);

        let html = `<div class="data-table-container">`;

        // Search
        html += `<div class="data-table-search">
            <input type="text" placeholder="Search..." value="${escapeHtml(searchTerm)}" id="dt-search" />
        </div>`;

        // Table
        html += `<table class="data-table"><thead><tr>`;
        for (const col of columns) {
            const isActive = sortKey === col.key;
            const icon = isActive
                ? (sortDir === 'asc' ? '&#9650;' : '&#9660;')
                : '&#9650;';
            const activeClass = isActive ? 'active' : '';
            html += `<th data-key="${col.key}">${escapeHtml(col.label)} <span class="sort-icon ${activeClass}">${icon}</span></th>`;
        }
        html += `</tr></thead><tbody>`;

        if (pageData.length === 0) {
            html += `<tr><td colspan="${columns.length}" style="text-align:center;color:var(--text-muted);padding:24px;">No data</td></tr>`;
        } else {
            for (const row of pageData) {
                const clickable = onRowClick ? 'clickable' : '';
                html += `<tr class="${clickable}" data-row-id="${escapeHtml(row.id || '')}">`;
                for (const col of columns) {
                    const val = row[col.key];
                    let cellHtml;
                    if (col.render) {
                        cellHtml = col.render(val, row);
                    } else if (col.key.includes('_at') || col.key === 'timestamp') {
                        cellHtml = `<span title="${escapeHtml(val)}">${timeAgo(val)}</span>`;
                    } else {
                        cellHtml = escapeHtml(val);
                    }
                    html += `<td>${cellHtml}</td>`;
                }
                html += `</tr>`;
            }
        }

        html += `</tbody></table>`;

        // Pagination
        if (totalPages > 1) {
            html += `<div class="pagination">`;
            html += `<button id="dt-prev" ${currentPage === 0 ? 'disabled' : ''}>&laquo; Prev</button>`;

            const maxVisible = 7;
            let startPage = Math.max(0, currentPage - Math.floor(maxVisible / 2));
            let endPage = Math.min(totalPages, startPage + maxVisible);
            if (endPage - startPage < maxVisible) {
                startPage = Math.max(0, endPage - maxVisible);
            }

            for (let i = startPage; i < endPage; i++) {
                html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i + 1}</button>`;
            }

            html += `<button id="dt-next" ${currentPage === totalPages - 1 ? 'disabled' : ''}>Next &raquo;</button>`;
            html += `<span class="page-info">${sorted.length} results</span>`;
            html += `</div>`;
        }

        html += `</div>`;
        container.innerHTML = html;

        // Bind events
        const searchInput = container.querySelector('#dt-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchTerm = e.target.value;
                currentPage = 0;
                render();
                // Re-focus the input and set cursor position
                const newInput = container.querySelector('#dt-search');
                if (newInput) {
                    newInput.focus();
                    newInput.setSelectionRange(searchTerm.length, searchTerm.length);
                }
            });
        }

        // Sort headers
        container.querySelectorAll('.data-table thead th').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.getAttribute('data-key');
                if (sortKey === key) {
                    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortKey = key;
                    sortDir = 'asc';
                }
                render();
            });
        });

        // Pagination buttons
        const prevBtn = container.querySelector('#dt-prev');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (currentPage > 0) { currentPage--; render(); }
            });
        }

        const nextBtn = container.querySelector('#dt-next');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                if (currentPage < totalPages - 1) { currentPage++; render(); }
            });
        }

        container.querySelectorAll('.page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentPage = parseInt(btn.getAttribute('data-page'), 10);
                render();
            });
        });

        // Row click
        if (onRowClick) {
            container.querySelectorAll('.data-table tbody tr.clickable').forEach(tr => {
                tr.addEventListener('click', () => {
                    const rowId = tr.getAttribute('data-row-id');
                    const row = data.find(r => String(r.id) === rowId);
                    if (row) onRowClick(row);
                });
            });
        }
    }

    render();
}
