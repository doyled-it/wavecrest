class Wavecrest < Formula
  desc "Wave Terminal companion for AI coding agents"
  homepage "https://github.com/doyled-it/wavecrest"
  version "0.1.3"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/doyled-it/wavecrest/releases/download/v#{version}/wavecrest-darwin-arm64.tar.gz"
      sha256 "0019dfc4b32d63c1392aa264aed2253c1e0c2fb09216f8e2cc269bbfb8bb49b5"
    end
    on_intel do
      odie "wavecrest does not yet ship a darwin-x64 binary; Intel + Linux support is on the phase 2 roadmap."
    end
  end

  on_linux do
    odie "wavecrest does not yet ship a Linux binary; Linux + Intel support is on the phase 2 roadmap."
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
    # `doctor` runs without a daemon and prints a structured report; we just
    # verify the binary launches and produces our expected output marker.
    assert_match "wavecrest:", shell_output("#{bin}/wavecrest doctor 2>&1", 1)
  end
end
