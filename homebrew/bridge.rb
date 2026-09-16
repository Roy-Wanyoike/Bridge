# homebrew/bridge.rb — Homebrew formula for the Bridge CLI.
#
# Installed from the GitHub release binaries produced by
# .github/workflows/release.yml (inline `bun build --compile`; the artifact
# naming layout matches scripts/package-release.mjs exactly).
#
# NOTE: `version` below is pinned BY HAND as part of the release checklist
# (see RELEASE.md). The release workflow's guard job fails the release if
# this value drifts from the pushed vX.Y.Z tag.
#
# Local tap layout (for testing):
#   brew tap-new <user>/bridge
#   cp homebrew/bridge.rb $(brew --repository)/Library/Taps/<user>/homebrew-bridge/
#   brew install <user>/bridge/bridge
class Bridge < Formula
  desc "One contract, every language, zero interoperability drift"
  homepage "https://github.com/Roy-Wanyoike/bridge"
  # Release checklist: bump to the tag version (and pin the sha256 lines
  # below) when cutting a release — the workflow guard asserts this equals
  # the pushed tag.
  version "0.2.1"
  license "MIT"

  # sha256 is :no_check until the release checklist step replaces it with
  # the real digest for that target, taken from the release's
  # `checksums-sha256.txt` (the workflow uploads it next to the binaries).
  on_macos do
    if Hardware::CPU.intel?
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-darwin-amd64"
      sha256 :no_check # release checklist: pin from checksums-sha256.txt
    else
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-darwin-arm64"
      sha256 :no_check # release checklist: pin from checksums-sha256.txt
    end
  end
  on_linux do
    if Hardware::CPU.intel?
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-linux-amd64"
      sha256 :no_check # release checklist: pin from checksums-sha256.txt
    else
      url "https://github.com/Roy-Wanyoike/bridge/releases/download/v#{version}/bridge-v#{version}-linux-arm64"
      sha256 :no_check # release checklist: pin from checksums-sha256.txt
    end
  end

  def install
    binary = Dir["bridge-v#{version}-*"].first
    raise "No bridge-v#{version}-* binary found — formula version (#{version}) does not match the downloaded release assets" if binary.nil?
    bin.install binary => "bridge"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bridge version")
  end
end
