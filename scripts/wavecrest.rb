class Wavecrest < Formula
  desc "Wave Terminal companion for AI coding agents"
  homepage "https://github.com/doyled-it/wavecrest"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/doyled-it/wavecrest/releases/download/v0.1.3/wavecrest-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_FILL_AFTER_RELEASE"
    else
      odie "wavecrest currently supports only Apple Silicon. Linux + Intel support coming in phase 2."
    end
  end

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"wavecrest"
  end

  def caveats
    <<~EOS
      Wave Terminal companion installed!
      Next steps:
        wavecrest install
        # then in a fresh Wave terminal block (not inside tmux):
        wavecrest auth-set
        # then restart Wave and drag in the wavecrest widget
      Run `wavecrest doctor` to verify your setup.
    EOS
  end

  test do
    assert_match "wavecrest", shell_output("#{bin}/wavecrest --version")
  end
end
