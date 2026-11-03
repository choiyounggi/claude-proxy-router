# Copy of the formula published in choiyounggi/homebrew-tap (Formula/claude-proxy-router.rb); edit it there.
# For a new release: npm publish, then update url and sha256:
#   curl -sL https://registry.npmjs.org/claude-proxy-router/-/claude-proxy-router-<version>.tgz | shasum -a 256
class ClaudeProxyRouter < Formula
  desc "Route Anthropic API requests to the local Claude account with the most headroom"
  homepage "https://github.com/choiyounggi/claude-proxy-router"
  url "https://registry.npmjs.org/claude-proxy-router/-/claude-proxy-router-0.2.0.tgz"
  sha256 "38bb85e36fd3948a8696a147b789fc2d7ba94cc58c4a2db743b1fd9a1215b335"
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
