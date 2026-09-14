import mysql from 'mysql2/promise';
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database: process.argv[2] ?? 'forexplore_javafileupload_flow_20260913', connectionLimit: 4 });
const [rows] = await pool.query(`SELECT r.display_name, r.repository_id, r.role, r.active_revision,
  (SELECT COUNT(*) FROM module_artifacts a WHERE a.repository_id = r.repository_id) AS artifacts,
  (SELECT COUNT(*) FROM module_artifacts a WHERE a.repository_id = r.repository_id AND a.kind = 'module-summary' AND a.status = 'current') AS current_summaries,
  (SELECT COUNT(*) FROM search_documents d WHERE d.repository_id = r.repository_id AND d.kind = 'summary') AS summary_documents,
  (SELECT COUNT(*) FROM search_documents d WHERE d.repository_id = r.repository_id AND d.kind = 'symbol') AS symbol_documents
  FROM repositories r ORDER BY r.role, r.display_name`);
console.table(rows.map((row) => ({ repo: row.display_name, role: row.role, artifacts: row.artifacts, currentSummaries: row.current_summaries, summaryDocs: row.summary_documents, symbolDocs: row.symbol_documents })));
await pool.end();
