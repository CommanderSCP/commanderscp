Name:           scp-widget
Version:        1.0.0
Release:        1%{?dist}
Summary:        CommanderSCP scp-build-rpm-v1 real-counterparty fixture
License:        Apache-2.0
Source0:        %{name}-%{version}.tar.gz
BuildRequires:  gcc
BuildRequires:  make

%description
A C program built from source so the fixture exercises the image's compiler, not only rpmbuild's
packaging of files — a noarch fixture would prove the toolchain is present without ever running it.

%prep
%autosetup

%build
make -C src %{?_smp_mflags} CFLAGS="%{optflags}"

%install
install -D -m 0755 src/scp-widget %{buildroot}%{_bindir}/scp-widget

%files
%{_bindir}/scp-widget

%changelog
* Wed Sep 23 2026 CommanderSCP <noreply@commanderscp.invalid> - 1.0.0-1
- Fixture for the M28.1 real-counterparty run.
