import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./types.js";
import { parsePomXml } from "./pom-xml.js";

/**
 * A real-shaped Spring Boot POM: a parent, a properties block, a `<dependencyManagement>` import,
 * the project's own `<dependencies>`, a `<build><plugins>` block and a `<profiles>` section.
 *
 * Four of those five blocks contain `<dependency>`-shaped or `<version>`-shaped elements that a
 * name-matching parser would happily report.
 */
const SPRING_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <modelVersion>4.0.0</modelVersion>

  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.2</version>
  </parent>

  <groupId>com.example.scp</groupId>
  <artifactId>outpost-bridge</artifactId>
  <version>0.3.0</version>

  <properties>
    <java.version>21</java.version>
    <testcontainers.version>1.20.1</testcontainers.version>
  </properties>

  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.testcontainers</groupId>
        <artifactId>testcontainers-bom</artifactId>
        <version>\${testcontainers.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>

  <dependencies>
    <!-- Version comes from the parent's dependencyManagement. -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <version>42.7.3</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>\${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.3</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>jakarta.servlet</groupId>
      <artifactId>jakarta.servlet-api</artifactId>
      <version>6.0.0</version>
      <scope>provided</scope>
    </dependency>
    <dependency>
      <groupId>commons-io</groupId>
      <artifactId>commons-io</artifactId>
      <version>[2.11.0,3.0.0)</version>
    </dependency>
    <dependency>
      <groupId>org.projectlombok</groupId>
      <artifactId>lombok</artifactId>
      <version>1.18.34</version>
      <optional>true</optional>
      <exclusions>
        <exclusion>
          <groupId>org.never</groupId>
          <artifactId>appears</artifactId>
        </exclusion>
      </exclusions>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.3.1</version>
      </plugin>
    </plugins>
  </build>

  <profiles>
    <profile>
      <id>native</id>
      <dependencies>
        <dependency>
          <groupId>org.graalvm.buildtools</groupId>
          <artifactId>native-maven-plugin</artifactId>
          <version>0.10.2</version>
        </dependency>
      </dependencies>
    </profile>
  </profiles>
</project>
`;

describe("parsePomXml", () => {
  const deps = parsePomXml(SPRING_POM);
  const coords = deps.map((d) => d.coordinate);

  it("reads ONLY the project's own <dependencies>, matched by full path", () => {
    expect(coords).toEqual([
      "org.springframework.boot:spring-boot-starter-web",
      "org.postgresql:postgresql",
      "com.fasterxml.jackson.core:jackson-databind",
      "org.junit.jupiter:junit-jupiter",
      "jakarta.servlet:jakarta.servlet-api",
      "commons-io:commons-io",
      "org.projectlombok:lombok"
    ]);
  });

  it("excludes dependencyManagement, plugins, profiles, exclusions and the parent", () => {
    // Each of these is a `<dependency>`- or `<version>`-shaped element that a name-matching parser
    // reports as a dependency the module does not actually have.
    expect(coords).not.toContain("org.testcontainers:testcontainers-bom");
    expect(coords).not.toContain("org.apache.maven.plugins:maven-surefire-plugin");
    expect(coords).not.toContain("org.graalvm.buildtools:native-maven-plugin");
    expect(coords).not.toContain("org.never:appears");
    expect(coords).not.toContain("org.springframework.boot:spring-boot-starter-parent"); // parent
  });

  it("reports an INHERITED version as unresolved rather than guessing (out of scope, §1)", () => {
    const web = deps.find(
      (d) => d.coordinate === "org.springframework.boot:spring-boot-starter-web"
    );
    expect(web?.constraint).toBe("unresolved");
    expect(web?.version).toBeUndefined();
    expect(web?.declared).toBeUndefined();
    expect(web?.note).toContain("parent POM");
    // But the ROW still exists: the reverse query "who declares spring-boot-starter-web?" must
    // still answer. Only the version is withheld.
    expect(web?.scope).toBe("runtime");
  });

  it("reports a ${property} version as unresolved rather than interpolating (out of scope, §2)", () => {
    const jackson = deps.find(
      (d) => d.coordinate === "com.fasterxml.jackson.core:jackson-databind"
    );
    expect(jackson?.constraint).toBe("unresolved");
    expect(jackson?.version).toBeUndefined();
    // The literal text is kept so a human can see what was in the file.
    expect(jackson?.declared).toBe("${jackson.version}");
  });

  it("NEGATIVE CONTROL: a literal version in the very same block IS parsed", () => {
    // Without this, both unresolved assertions would pass if the parser never produced a version at
    // all — the vacuous-absence failure.
    expect(deps.find((d) => d.coordinate === "org.postgresql:postgresql")).toMatchObject({
      constraint: "pinned",
      declared: "42.7.3",
      version: { major: 42, minor: 7, patch: 3, precision: 3 },
      scope: "runtime"
    });
  });

  it("maps Maven scopes onto the three-value scope", () => {
    expect(deps.find((d) => d.coordinate === "org.junit.jupiter:junit-jupiter")?.scope).toBe("dev");
    expect(deps.find((d) => d.coordinate === "jakarta.servlet:jakarta.servlet-api")?.scope).toBe(
      "build"
    );
  });

  it("distinguishes a Maven version RANGE from a soft pin", () => {
    const commons = deps.find((d) => d.coordinate === "commons-io:commons-io");
    expect(commons?.constraint).toBe("range");
    expect(commons?.declared).toBe("[2.11.0,3.0.0)");
    // A range names a set; producing 2.11.0 for it would assert the floor as the declared version.
    expect(commons?.version).toBeUndefined();
  });

  it("keeps <optional>true</optional> as an annotation, not an exclusion", () => {
    const lombok = deps.find((d) => d.coordinate === "org.projectlombok:lombok");
    expect(lombok?.constraint).toBe("pinned");
    expect(lombok?.note).toContain("optional");
  });

  it("reports the line each dependency starts on", () => {
    const lines = SPRING_POM.split("\n");
    const pg = deps.find((d) => d.coordinate === "org.postgresql:postgresql");
    expect(lines[(pg?.line ?? 0) - 1]).toContain("<dependency>");
    expect(lines[pg?.line ?? 0]).toContain("org.postgresql");
  });

  it("throws on a document it cannot read instead of returning an empty inventory", () => {
    expect(() => parsePomXml("<notapom/>")).toThrow(ManifestParseError);
    expect(() => parsePomXml("<project><dependencies>")).toThrow(ManifestParseError);
    // NEGATIVE CONTROL: a POM that genuinely declares nothing is NOT an error.
    expect(parsePomXml("<project><modelVersion>4.0.0</modelVersion></project>")).toEqual([]);
  });

  it("refuses a MISMATCHED or unbalanced closing tag, not only a truncated document", () => {
    // The walker's own comment claimed it "throws on a malformed document instead of returning a
    // partial one", and the end-of-document stack check was the only thing behind that claim — so a
    // document with equal numbers of wrong opens and closes ended with an empty stack and was
    // accepted. `<version>1.0</version></wrong>` parsed as well-formed.
    expect(() =>
      parsePomXml(
        "<project><dependencies><dependency><groupId>a</groupId><artifactId>b</artifactId>" +
          "<version>1.0</version></wrong></dependency></dependencies></project>"
      )
    ).toThrow(ManifestParseError);
    // Stack underflow: a close with nothing open. Also previously accepted, silently.
    expect(() => parsePomXml("<project></project></wrong>")).toThrow(ManifestParseError);
    // NEGATIVE CONTROL: the correctly-nested version of the first document still parses.
    expect(
      parsePomXml(
        "<project><dependencies><dependency><groupId>a</groupId><artifactId>b</artifactId>" +
          "<version>1.0</version></dependency></dependencies></project>"
      ).map((d) => d.coordinate)
    ).toEqual(["a:b"]);
  });

  it("decodes XML entities in the fields it reads, in the right order", () => {
    // `decodeEntities` survived being made a no-op: no fixture carried an entity in a field the
    // walker actually reads. Maven coordinates do not normally contain one, but every child value
    // the walker collects goes through this function, so a silent no-op would corrupt any that did.
    //
    // The ORDER is the substantive property: `&amp;` must be replaced LAST, or `&amp;lt;` decodes
    // all the way to `<` — a double-decode that turns escaped text into markup.
    const pom =
      "<project><dependencies><dependency>" +
      "<groupId>a&amp;b</groupId><artifactId>c&amp;lt;d</artifactId><version>1.0</version>" +
      "</dependency></dependencies></project>";
    expect(parsePomXml(pom)[0]?.coordinate).toBe("a&b:c&lt;d");
  });

  it("ignores XML comments, CDATA and namespace prefixes", () => {
    const pom = `<m:project xmlns:m="http://maven.apache.org/POM/4.0.0">
      <m:dependencies>
        <!-- <m:dependency><m:groupId>ghost</m:groupId></m:dependency> -->
        <m:dependency>
          <m:groupId><![CDATA[org.slf4j]]></m:groupId>
          <m:artifactId>slf4j-api</m:artifactId>
          <m:version>2.0.16</m:version>
        </m:dependency>
      </m:dependencies>
    </m:project>`;
    const parsed = parsePomXml(pom);
    expect(parsed.map((d) => d.coordinate)).toEqual(["org.slf4j:slf4j-api"]);
    expect(parsed[0]?.version).toMatchObject({ major: 2, minor: 0, patch: 16 });
  });
});
