import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('[PaperLens] 找不到根容器元素 #root');
}

createRoot(container).render(<App />);
