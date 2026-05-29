class Wavecrest < Formula
  desc "Wave Terminal companion for AI coding agents"
  homepage "https://github.com/doyled-it/wavecrest"
  version "0.1.5"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/doyled-it/wavecrest/releases/download/v#{version}/wavecrest-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/doyled-it/wavecrest/releases/download/v#{version}/wavecrest-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER_DARWIN_X64"
    end
  end

  on_linux do
    odie "wavecrest does not yet ship a Linux binary; Linux support is on the phase 2 roadmap."
  end

  livecheck do
    url :stable
    strategy :github_latest
  end

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"wavecrest"
  end

  def caveats
    <<~EOS
      Wave Terminal companion installed.

      Next steps:
        wavecrest install
        # then in a fresh Wave terminal block (not inside tmux):
        wavecrest auth-set
        # restart Wave and drag the wavecrest widget into a block

      Run `wavecrest doctor` to verify your setup.
    EOS
  end

  test do
    assert_match "wavecrest:", shell_output("#{bin}/wavecrest doctor 2>&1", 1)
  end
end
