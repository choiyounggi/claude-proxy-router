# Homebrew formula. Copy into a tap repo (choiyounggi/homebrew-tap, Formula/) after `npm publish`,
# then fill url/sha256 for the published version:
#   curl -sL https://registry.npmjs.org/claude-proxy-router/-/claude-proxy-router-0.1.0.tgz | shasum -a 256
class ClaudeProxyRouter < Formula
  desc "Route Anthropic API requests to the local Claude account with the most headroom"
  homepage "https://github.com/choiyounggi/claude-proxy-router"
  url "https://registry.npmjs.org/claude-proxy-router/-/claude-proxy-router-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on :macos
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  service do
    run [opt_bin/"claude-proxy-router", "start"]
    keep_alive true
    log_path var/"log/claude-proxy-router.log"
    error_log_path var/"log/claude-proxy-router.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-proxy-router --version")
  end
end
