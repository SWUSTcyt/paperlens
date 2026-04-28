import { createRoot } from 'react-dom/client';
import Options from './Options';
import '../sidepanel/style.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('[PaperLens] Options 找不到根容器 #root');
}

createRoot(container).render(<Options />);
