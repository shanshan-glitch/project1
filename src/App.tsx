import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Registration from "@/pages/Registration";
import Report from "@/pages/Report";
import Visualization from "@/pages/Visualization";
import KnowledgeQA from "@/pages/KnowledgeQA";
import KnowledgeBase from "@/pages/KnowledgeBase";
import IntelFeed from "@/pages/IntelFeed";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/registration" element={<Registration />} />
        <Route path="/report" element={<Report />} />
        <Route path="/visualization" element={<Visualization />} />
        <Route path="/qa" element={<KnowledgeQA />} />
        <Route path="/intel" element={<IntelFeed />} />
        <Route path="/knowledge" element={<KnowledgeBase />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
