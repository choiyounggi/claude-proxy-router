# Copy of the formula published in choiyounggi/homebrew-tap (Formula/claude-proxy-router.rb); edit it there.
# For a new release: npm publish, then update url and sha256:
#   curl -sL https://registry.npmjs.org/claude-proxy-router/-/claude-proxy-router-<version>.tgz | shasum -a 256
class ClaudeProxyRouter < Formula
  desc "Route Anthropic API requests to the local Claude account with the most headroom"
  homepage "https://github.com/choiyounggi/claude-proxy-router"
  url "https://registry.npmjs.org/claude-proxy-router/-/claude-proxy-router-0.1.0.tgz"
  sha256 "a1935f60f888acf45e15d8b9231d94ada501af0528b9a66d97ddae04e302b60b"
  license "MIT"

  depends_on :macos
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  service do
    run [opt_bin/"claude-proxy-router", "start"]
    keep_alive true
    log_path var/"log/claude-proxy-router.log"
    error_log_path var/"log/claude-proxy-router.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-proxy-router --version")
    assert_match "unreachable", shell_output("#{bin}/claude-proxy-router ping http://127.0.0.1:1 x", 1)
  end
end
