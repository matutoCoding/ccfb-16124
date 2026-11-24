import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ProjectsPage } from '../pages/ProjectsPage';
import { WindDataPage } from '../pages/WindDataPage';
import { VisualizationPage } from '../pages/VisualizationPage';
import { SectorsPage } from '../pages/SectorsPage';
import { ReportPage } from '../pages/ReportPage';

const NAV = [
  { to: '/projects', label: '平台项目' },
  { to: '/wind', label: '风场数据' },
  { to: '/visualization', label: '气流可视化' },
  { to: '/sectors', label: '限制扇区' },
  { to: '/report', label: '评审报告' },
];

export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">H</span>
          <div>
            <div className="brand-title">直升机甲板</div>
            <div className="brand-sub">气流与排烟评估 · CAP437</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          数据本地存储于 IndexedDB
          <br />不上传外部服务器
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/wind" element={<WindDataPage />} />
          <Route path="/visualization" element={<VisualizationPage />} />
          <Route path="/sectors" element={<SectorsPage />} />
          <Route path="/report" element={<ReportPage />} />
        </Routes>
      </main>
    </div>
  );
}
