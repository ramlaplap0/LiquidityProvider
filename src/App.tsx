import { Routes, Route } from 'react-router'
import Home from './pages/Home'

export default function App() {
  return (
    <Routes>
      <Route path="./pages/Home.tsx" element={<Home />} />
    </Routes>
  )
}
