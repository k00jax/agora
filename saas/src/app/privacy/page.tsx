export default function PrivacyPage() {
  return (
    <div className="min-h-screen px-6 py-12 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Privacy Policy</h1>
      <div className="prose prose-invert prose-sm space-y-4 text-gray-300">
        <p><strong>Effective Date:</strong> July 2, 2026</p>

        <h2 className="text-lg font-semibold mt-6">1. Data We Collect</h2>
        <p>We collect your email address (for authentication), display name, and optionally an avatar URL. We store your conversation history for the purpose of providing the chat history feature. If you provide API keys, they are encrypted at rest and never logged.</p>

        <h2 className="text-lg font-semibold mt-6">2. Data We Do NOT Collect</h2>
        <p>We do not sell your data. We do not record your voice (speech recognition happens locally in your browser). We do not track your browsing activity across other sites.</p>

        <h2 className="text-lg font-semibold mt-6">3. Conversation Data</h2>
        <p>Your conversations with the AI models are stored in our database to provide the chat history feature. You may delete your conversations at any time through the app interface. Deleting a conversation permanently removes it from our systems.</p>

        <h2 className="text-lg font-semibold mt-6">4. Third-Party Services</h2>
        <p>We use the following third-party services:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Supabase</strong> — authentication and database hosting</li>
          <li><strong>Stripe</strong> — payment processing</li>
          <li><strong>AI Providers</strong> (OpenAI, Anthropic, Google, xAI, DeepSeek) — your messages are sent to these APIs when you interact with the corresponding models</li>
        </ul>

        <h2 className="text-lg font-semibold mt-6">5. Cookies</h2>
        <p>We use essential cookies for authentication sessions (via Supabase). We do not use tracking or advertising cookies.</p>

        <h2 className="text-lg font-semibold mt-6">6. Data Retention</h2>
        <p>Conversation data is retained until you delete it. Stripe purchase records are retained for tax and accounting purposes. You may request full account deletion by contacting us.</p>

        <h2 className="text-lg font-semibold mt-6">7. Contact</h2>
        <p>For privacy inquiries, contact us via the repository issues page.</p>
      </div>
    </div>
  );
}
