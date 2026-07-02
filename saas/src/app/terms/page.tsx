export default function TermsPage() {
  return (
    <div className="min-h-screen px-6 py-12 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Terms of Service</h1>
      <div className="prose prose-invert prose-sm space-y-4 text-gray-300">
        <p><strong>Effective Date:</strong> July 2, 2026</p>

        <h2 className="text-lg font-semibold mt-6">1. Acceptance of Terms</h2>
        <p>By accessing or using Agora ("the Service"), you agree to be bound by these Terms. If you do not agree, do not use the Service.</p>

        <h2 className="text-lg font-semibold mt-6">2. Description of Service</h2>
        <p>Agora provides a group chat interface where AI language models from multiple providers participate in roundtable discussions. You may interact with the AI participants via text or voice input.</p>

        <h2 className="text-lg font-semibold mt-6">3. User Accounts</h2>
        <p>You are responsible for maintaining the confidentiality of your account credentials. You must be at least 13 years old to use the Service.</p>

        <h2 className="text-lg font-semibold mt-6">4. API Keys</h2>
        <p>Users may optionally provide their own API keys for supported AI providers. These keys are encrypted at rest. You are responsible for any costs incurred through the use of your own keys. Agora also offers a credit-based system using shared API keys for users who prefer not to bring their own.</p>

        <h2 className="text-lg font-semibold mt-6">5. Credits and Payments</h2>
        <p>Credits are purchased through Stripe and are non-refundable except where required by law. Credit consumption is based on actual API token usage with per-model multipliers. Agora reserves the right to adjust credit pricing with notice.</p>

        <h2 className="text-lg font-semibold mt-6">6. Acceptable Use</h2>
        <p>You agree not to use the Service for any unlawful purpose, to generate harmful content, or to attempt to circumvent usage limits or credit metering.</p>

        <h2 className="text-lg font-semibold mt-6">7. Disclaimer</h2>
        <p>The Service is provided "as is." AI-generated content may be inaccurate, offensive, or inappropriate. Agora makes no warranties about the accuracy or suitability of AI-generated content.</p>

        <h2 className="text-lg font-semibold mt-6">8. Contact</h2>
        <p>Questions about these Terms? Contact us via the repository.</p>
      </div>
    </div>
  );
}
