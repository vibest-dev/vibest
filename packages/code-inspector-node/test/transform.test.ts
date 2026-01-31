import { describe, expect, it } from "vitest";

import { transform } from "../src/transform";

describe("transform", () => {
  const relativePath = "src/components/App.tsx";

  describe("Basic JSX transformation", () => {
    it("should add inspector attributes to simple JSX elements", () => {
      const code = `import React from 'react';

function App() {
  return <div>Hello World</div>;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return <div data-inspector-name="div" data-inspector="src/components/App.tsx:4:9">Hello World</div>;
				}"
			`);
    });

    it("should add inspector attributes to self-closing JSX elements", () => {
      const code = `import React from 'react';

function App() {
  return <input type="text" />;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return <input data-inspector-name="input" data-inspector="src/components/App.tsx:4:9" type="text" />;
				}"
			`);
    });

    it("should add inspector attributes to nested JSX elements", () => {
      const code = `import React from 'react';

function App() {
  return (
    <div>
      <span>Hello</span>
      <p>World</p>
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:5:4">
				      <span data-inspector-name="span" data-inspector="src/components/App.tsx:6:6">Hello</span>
				      <p data-inspector-name="p" data-inspector="src/components/App.tsx:7:6">World</p>
				    </div>);

				}"
			`);
    });
  });

  describe("TypeScript Support", () => {
    it("should handle JSX with type annotations", () => {
      const code = `import React from 'react';

interface Props {
  name: string;
}

function App({ name }: Props) {
  return <div>{name}</div>;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				interface Props {
				  name: string;
				}

				function App({ name }: Props) {
				  return <div data-inspector-name="div" data-inspector="src/components/App.tsx:8:9">{name}</div>;
				}"
			`);
    });

    it("should handle generic components", () => {
      const code = `import React from 'react';

function App<T>() {
  return <div>Generic Component</div>;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App<T>() {
				  return <div data-inspector-name="div" data-inspector="src/components/App.tsx:4:9">Generic Component</div>;
				}"
			`);
    });
  });

  describe("JSX Attribute Handling", () => {
    it("should handle JSX elements with existing attributes", () => {
      const code = `import React from 'react';

function App() {
  return <div className="container" id="app">Content</div>;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return <div data-inspector-name="div" data-inspector="src/components/App.tsx:4:9" className="container" id="app">Content</div>;
				}"
			`);
    });

    it("should handle JSX expression attributes", () => {
      const code = `import React from 'react';

function App() {
  const isActive = true;
  return <div className={isActive ? 'active' : 'inactive'}>Content</div>;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  const isActive = true;
				  return <div data-inspector-name="div" data-inspector="src/components/App.tsx:5:9" className={isActive ? 'active' : 'inactive'}>Content</div>;
				}"
			`);
    });
  });

  describe("Complex JSX Scenarios", () => {
    it("should handle JSX Fragment", () => {
      const code = `import React from 'react';

function App() {
  return (
    <>
      <div>First</div>
      <div>Second</div>
    </>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <>
				      <div data-inspector-name="div" data-inspector="src/components/App.tsx:6:6">First</div>
				      <div data-inspector-name="div" data-inspector="src/components/App.tsx:7:6">Second</div>
				    </>);

				}"
			`);
    });

    it("should handle React.Fragment syntax", () => {
      const code = `import React from 'react';

function App() {
  return (
    <React.Fragment>
      <div>First</div>
      <div>Second</div>
    </React.Fragment>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <React.Fragment>
				      <div data-inspector-name="div" data-inspector="src/components/App.tsx:6:6">First</div>
				      <div data-inspector-name="div" data-inspector="src/components/App.tsx:7:6">Second</div>
				    </React.Fragment>);

				}"
			`);
    });

    it("should handle Fragment with key prop", () => {
      const code = `import React, { Fragment } from 'react';

function App() {
  const items = ['a', 'b'];
  return (
    <div>
      {items.map(item => (
        <Fragment key={item}>
          <span>{item}</span>
          <br />
        </Fragment>
      ))}
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React, { Fragment } from 'react';

				function App() {
				  const items = ['a', 'b'];
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:6:4">
				      {items.map((item) =>
				      <Fragment key={item}>
				          <span data-inspector-name="span" data-inspector="src/components/App.tsx:9:10">{item}</span>
				          <br data-inspector-name="br" data-inspector="src/components/App.tsx:10:10" />
				        </Fragment>
				      )}
				    </div>);

				}"
			`);
    });

    it("should handle nested fragments", () => {
      const code = `import React from 'react';

function App() {
  return (
    <>
      <div>Outer</div>
      <>
        <span>Inner Fragment</span>
        <p>Content</p>
      </>
    </>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <>
				      <div data-inspector-name="div" data-inspector="src/components/App.tsx:6:6">Outer</div>
				      <>
				        <span data-inspector-name="span" data-inspector="src/components/App.tsx:8:8">Inner Fragment</span>
				        <p data-inspector-name="p" data-inspector="src/components/App.tsx:9:8">Content</p>
				      </>
				    </>);

				}"
			`);
    });

    it("should handle fragment with mixed content", () => {
      const code = `import React from 'react';

function App() {
  const showExtra = true;
  return (
    <>
      <h1>Title</h1>
      {showExtra && <p>Extra content</p>}
      <button>Action</button>
    </>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  const showExtra = true;
				  return (
				    <>
				      <h1 data-inspector-name="h1" data-inspector="src/components/App.tsx:7:6">Title</h1>
				      {showExtra && <p data-inspector-name="p" data-inspector="src/components/App.tsx:8:20">Extra content</p>}
				      <button data-inspector-name="button" data-inspector="src/components/App.tsx:9:6">Action</button>
				    </>);

				}"
			`);
    });

    it("should handle conditional rendering", () => {
      const code = `import React from 'react';

function App() {
  const showContent = true;
  return (
    <div>
      {showContent && <span>Content</span>}
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  const showContent = true;
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:6:4">
				      {showContent && <span data-inspector-name="span" data-inspector="src/components/App.tsx:7:22">Content</span>}
				    </div>);

				}"
			`);
    });

    it("should handle map rendering", () => {
      const code = `import React from 'react';

function App() {
  const items = ['a', 'b', 'c'];
  return (
    <ul>
      {items.map(item => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  const items = ['a', 'b', 'c'];
				  return (
				    <ul data-inspector-name="ul" data-inspector="src/components/App.tsx:6:4">
				      {items.map((item) =>
				      <li data-inspector-name="li" data-inspector="src/components/App.tsx:8:8" key={item}>{item}</li>
				      )}
				    </ul>);

				}"
			`);
    });

    it("should handle component event attributes", () => {
      const code = `import React from 'react';

function App() {
  return (
    <div>
      <button onClick={() => console.log('clicked')}>
        Click me
      </button>
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:5:4">
				      <button data-inspector-name="button" data-inspector="src/components/App.tsx:6:6" onClick={() => console.log('clicked')}>
				        Click me
				      </button>
				    </div>);

				}"
			`);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty JSX content", () => {
      const code = `import React from 'react';

function App() {
  return <div></div>;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return <div data-inspector-name="div" data-inspector="src/components/App.tsx:4:9"></div>;
				}"
			`);
    });

    it("should handle multi-line JSX attributes", () => {
      const code = `import React from 'react';

function App() {
  return (
    <div
      className="container"
      style={{ color: 'red' }}
      onClick={() => console.log('clicked')}
    >
      Content
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:5:4"
				    className="container"
				    style={{ color: 'red' }}
				    onClick={() => console.log('clicked')}>

				      Content
				    </div>);

				}"
			`);
    });

    it("should handle relative paths", () => {
      const code = `import React from 'react';

function Button() {
  return <button>Click me</button>;
}`;

      const result = transform(code, { relativePath: "components/Button.tsx" });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function Button() {
				  return <button data-inspector-name="button" data-inspector="components/Button.tsx:4:9">Click me</button>;
				}"
			`);
    });

    it("should handle different root paths", () => {
      const code = `import React from 'react';

function Widget() {
  return <div>Widget Content</div>;
}`;

      const result = transform(code, {
        relativePath: "app/components/Widget.tsx",
      });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function Widget() {
				  return <div data-inspector-name="div" data-inspector="app/components/Widget.tsx:4:9">Widget Content</div>;
				}"
			`);
    });
  });

  describe("Different File Types", () => {
    it("should handle .jsx files", () => {
      const code = `import React from 'react';

function App() {
  return <div>JSX File</div>;
}`;

      const result = transform(code, {
        relativePath: "src/components/App.jsx",
      });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return <div data-inspector-name="div" data-inspector="src/components/App.jsx:4:9">JSX File</div>;
				}"
			`);
    });

    it("should handle .tsx files", () => {
      const code = `import React from 'react';

interface Props {
  title: string;
}

function App({ title }: Props) {
  return <div>{title}</div>;
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				interface Props {
				  title: string;
				}

				function App({ title }: Props) {
				  return <div data-inspector-name="div" data-inspector="src/components/App.tsx:8:9">{title}</div>;
				}"
			`);
    });

    it("should handle complex JSX structures", () => {
      const code = `import React from 'react';

function App() {
  return (
    <main>
      <header>
        <h1>Title</h1>
      </header>
      <section>
        <article>
          <p>Content</p>
        </article>
      </section>
    </main>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <main data-inspector-name="main" data-inspector="src/components/App.tsx:5:4">
				      <header data-inspector-name="header" data-inspector="src/components/App.tsx:6:6">
				        <h1 data-inspector-name="h1" data-inspector="src/components/App.tsx:7:8">Title</h1>
				      </header>
				      <section data-inspector-name="section" data-inspector="src/components/App.tsx:9:6">
				        <article data-inspector-name="article" data-inspector="src/components/App.tsx:10:8">
				          <p data-inspector-name="p" data-inspector="src/components/App.tsx:11:10">Content</p>
				        </article>
				      </section>
				    </main>);

				}"
			`);
    });
  });

  describe("Vue JSX Support", () => {
    it("should handle Vue JSX syntax", () => {
      const code = `import { defineComponent } from 'vue';

export default defineComponent({
  name: 'MyComponent',
  render() {
    return <div>Vue JSX Component</div>;
  }
});`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import { defineComponent } from 'vue';

				export default defineComponent({
				  name: 'MyComponent',
				  render() {
				    return <div data-inspector-name="div" data-inspector="src/components/App.tsx:6:11">Vue JSX Component</div>;
				  }
				});"
			`);
    });

    it("should handle Vue functional components", () => {
      const code = `import { FunctionalComponent } from 'vue';

const MyComponent: FunctionalComponent = () => {
  return <span>Functional Component</span>;
};`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import { FunctionalComponent } from 'vue';

				const MyComponent: FunctionalComponent = () => {
				  return <span data-inspector-name="span" data-inspector="src/components/App.tsx:4:9">Functional Component</span>;
				};"
			`);
    });
  });

  describe("Special JSX Scenarios", () => {
    it("should handle comments in JSX", () => {
      const code = `import React from 'react';

function App() {
  return (
    <div>
      {/* This is a comment */}
      <p>Content</p>
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:5:4">
				      {/* This is a comment */}
				      <p data-inspector-name="p" data-inspector="src/components/App.tsx:7:6">Content</p>
				    </div>);

				}"
			`);
    });

    it("should handle text nodes in JSX", () => {
      const code = `import React from 'react';

function App() {
  return (
    <div>
      Hello 
      <strong>World</strong>
      !
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function App() {
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:5:4">
				      Hello 
				      <strong data-inspector-name="strong" data-inspector="src/components/App.tsx:7:6">World</strong>
				      !
				    </div>);

				}"
			`);
    });

    it("should handle custom components", () => {
      const code = `import React from 'react';

const CustomButton = ({ children }) => <button>{children}</button>;

function App() {
  return (
    <div>
      <CustomButton>Click me</CustomButton>
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				const CustomButton = ({ children }) => <button data-inspector-name="button" data-inspector="src/components/App.tsx:3:39">{children}</button>;

				function App() {
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:7:4">
				      <CustomButton data-inspector-name="CustomButton" data-inspector="src/components/App.tsx:8:6">Click me</CustomButton>
				    </div>);

				}"
			`);
    });
  });

  describe("React Native Support", () => {
    it("should add dataSet attributes to React Native components", () => {
      const code = `import React from 'react';
import { View, Text } from 'react-native';

function App() {
  return (
    <View>
      <Text>Hello React Native</Text>
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, Text } from 'react-native';

				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:6:4", "inspector-name": "View" }}>
				      <Text dataSet={{ inspector: "src/components/App.tsx:7:6", "inspector-name": "Text" }}>Hello React Native</Text>
				    </View>);

				}"
			`);
    });

    it("should handle React Native components with existing props", () => {
      const code = `import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

function App() {
  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity onPress={() => console.log('pressed')}>
        <Text style={{ color: 'blue' }}>Press me</Text>
      </TouchableOpacity>
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, Text, TouchableOpacity } from 'react-native';

				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:6:4", "inspector-name": "View" }} style={{ flex: 1 }}>
				      <TouchableOpacity dataSet={{ inspector: "src/components/App.tsx:7:6", "inspector-name": "TouchableOpacity" }} onPress={() => console.log('pressed')}>
				        <Text dataSet={{ inspector: "src/components/App.tsx:8:8", "inspector-name": "Text" }} style={{ color: 'blue' }}>Press me</Text>
				      </TouchableOpacity>
				    </View>);

				}"
			`);
    });

    it("should handle React Native components with nested structure", () => {
      const code = `import React from 'react';
import { View, Text } from 'react-native';

function App() {
  return (
    <View>
      <View>
        <Text>Nested React Native Text</Text>
        <Text>Another Text</Text>
      </View>
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, Text } from 'react-native';

				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:6:4", "inspector-name": "View" }}>
				      <View dataSet={{ inspector: "src/components/App.tsx:7:6", "inspector-name": "View" }}>
				        <Text dataSet={{ inspector: "src/components/App.tsx:8:8", "inspector-name": "Text" }}>Nested React Native Text</Text>
				        <Text dataSet={{ inspector: "src/components/App.tsx:9:8", "inspector-name": "Text" }}>Another Text</Text>
				      </View>
				    </View>);

				}"
			`);
    });

    it("should handle web components separately from React Native", () => {
      const code = `import React from 'react';

function WebApp() {
  return (
    <div>
      <span>Web component</span>
      <button>Web button</button>
    </div>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';

				function WebApp() {
				  return (
				    <div data-inspector-name="div" data-inspector="src/components/App.tsx:5:4">
				      <span data-inspector-name="span" data-inspector="src/components/App.tsx:6:6">Web component</span>
				      <button data-inspector-name="button" data-inspector="src/components/App.tsx:7:6">Web button</button>
				    </div>);

				}"
			`);
    });

    it("should handle React Native ScrollView and FlatList", () => {
      const code = `import React from 'react';
import { ScrollView, FlatList, Text } from 'react-native';

function App() {
  const data = [{ id: '1', text: 'Item 1' }];
  
  return (
    <ScrollView>
      <FlatList
        data={data}
        renderItem={({ item }) => <Text key={item.id}>{item.text}</Text>}
      />
    </ScrollView>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { ScrollView, FlatList, Text } from 'react-native';

				function App() {
				  const data = [{ id: '1', text: 'Item 1' }];

				  return (
				    <ScrollView dataSet={{ inspector: "src/components/App.tsx:8:4", "inspector-name": "ScrollView" }}>
				      <FlatList dataSet={{ inspector: "src/components/App.tsx:9:6", "inspector-name": "FlatList" }}
				      data={data}
				      renderItem={({ item }) => <Text dataSet={{ inspector: "src/components/App.tsx:11:34", "inspector-name": "Text" }} key={item.id}>{item.text}</Text>} />

				    </ScrollView>);

				}"
			`);
    });

    it("should handle React Native StyleSheet components", () => {
      const code = `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  container: { flex: 1 },
  text: { fontSize: 16 }
});

function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Styled Text</Text>
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, Text, StyleSheet } from 'react-native';

				const styles = StyleSheet.create({
				  container: { flex: 1 },
				  text: { fontSize: 16 }
				});

				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:11:4", "inspector-name": "View" }} style={styles.container}>
				      <Text dataSet={{ inspector: "src/components/App.tsx:12:6", "inspector-name": "Text" }} style={styles.text}>Styled Text</Text>
				    </View>);

				}"
			`);
    });

    it("should handle React Native Image and ImageBackground", () => {
      const code = `import React from 'react';
import { View, Image, ImageBackground } from 'react-native';

function App() {
  return (
    <View>
      <Image source={{ uri: 'https://example.com/image.jpg' }} />
      <ImageBackground source={{ uri: 'https://example.com/bg.jpg' }}>
        <View>
          <Image source={require('./local-image.png')} />
        </View>
      </ImageBackground>
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, Image, ImageBackground } from 'react-native';

				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:6:4", "inspector-name": "View" }}>
				      <Image dataSet={{ inspector: "src/components/App.tsx:7:6", "inspector-name": "Image" }} source={{ uri: 'https://example.com/image.jpg' }} />
				      <ImageBackground dataSet={{ inspector: "src/components/App.tsx:8:6", "inspector-name": "ImageBackground" }} source={{ uri: 'https://example.com/bg.jpg' }}>
				        <View dataSet={{ inspector: "src/components/App.tsx:9:8", "inspector-name": "View" }}>
				          <Image dataSet={{ inspector: "src/components/App.tsx:10:10", "inspector-name": "Image" }} source={require('./local-image.png')} />
				        </View>
				      </ImageBackground>
				    </View>);

				}"
			`);
    });

    it("should handle React Native TextInput and Button", () => {
      const code = `import React from 'react';
import { View, TextInput, Button } from 'react-native';

function App() {
  return (
    <View>
      <TextInput
        placeholder="Enter text"
        onChangeText={(text) => console.log(text)}
      />
      <Button title="Submit" onPress={() => console.log('submit')} />
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, TextInput, Button } from 'react-native';

				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:6:4", "inspector-name": "View" }}>
				      <TextInput dataSet={{ inspector: "src/components/App.tsx:7:6", "inspector-name": "TextInput" }}
				      placeholder="Enter text"
				      onChangeText={(text) => console.log(text)} />

				      <Button dataSet={{ inspector: "src/components/App.tsx:11:6", "inspector-name": "Button" }} title="Submit" onPress={() => console.log('submit')} />
				    </View>);

				}"
			`);
    });

    it("should handle React Native with custom components", () => {
      const code = `import React from 'react';
import { View, Text } from 'react-native';

const CustomCard = ({ children }) => (
  <View style={{ padding: 10 }}>
    {children}
  </View>
);

function App() {
  return (
    <View>
      <CustomCard>
        <Text>Card Content</Text>
      </CustomCard>
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, Text } from 'react-native';

				const CustomCard = ({ children }) =>
				<View dataSet={{ inspector: "src/components/App.tsx:5:2", "inspector-name": "View" }} style={{ padding: 10 }}>
				    {children}
				  </View>;


				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:12:4", "inspector-name": "View" }}>
				      <CustomCard data-inspector-name="CustomCard" data-inspector="src/components/App.tsx:13:6">
				        <Text dataSet={{ inspector: "src/components/App.tsx:14:8", "inspector-name": "Text" }}>Card Content</Text>
				      </CustomCard>
				    </View>);

				}"
			`);
    });

    it("should handle React Native SafeAreaView and StatusBar", () => {
      const code = `import React from 'react';
import { SafeAreaView, StatusBar, View, Text } from 'react-native';

function App() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />
      <View>
        <Text>Safe Area Content</Text>
      </View>
    </SafeAreaView>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { SafeAreaView, StatusBar, View, Text } from 'react-native';

				function App() {
				  return (
				    <SafeAreaView dataSet={{ inspector: "src/components/App.tsx:6:4", "inspector-name": "SafeAreaView" }} style={{ flex: 1 }}>
				      <StatusBar dataSet={{ inspector: "src/components/App.tsx:7:6", "inspector-name": "StatusBar" }} barStyle="dark-content" />
				      <View dataSet={{ inspector: "src/components/App.tsx:8:6", "inspector-name": "View" }}>
				        <Text dataSet={{ inspector: "src/components/App.tsx:9:8", "inspector-name": "Text" }}>Safe Area Content</Text>
				      </View>
				    </SafeAreaView>);

				}"
			`);
    });

    it("should handle React Native Modal and Alert", () => {
      const code = `import React from 'react';
import { View, Text, Modal, TouchableOpacity } from 'react-native';

function App() {
  return (
    <View>
      <Modal visible={true} animationType="slide">
        <View>
          <Text>Modal Content</Text>
          <TouchableOpacity>
            <Text>Close</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}`;

      const result = transform(code, { relativePath });

      expect(result?.code).toMatchInlineSnapshot(`
				"import React from 'react';
				import { View, Text, Modal, TouchableOpacity } from 'react-native';

				function App() {
				  return (
				    <View dataSet={{ inspector: "src/components/App.tsx:6:4", "inspector-name": "View" }}>
				      <Modal dataSet={{ inspector: "src/components/App.tsx:7:6", "inspector-name": "Modal" }} visible={true} animationType="slide">
				        <View dataSet={{ inspector: "src/components/App.tsx:8:8", "inspector-name": "View" }}>
				          <Text dataSet={{ inspector: "src/components/App.tsx:9:10", "inspector-name": "Text" }}>Modal Content</Text>
				          <TouchableOpacity dataSet={{ inspector: "src/components/App.tsx:10:10", "inspector-name": "TouchableOpacity" }}>
				            <Text dataSet={{ inspector: "src/components/App.tsx:11:12", "inspector-name": "Text" }}>Close</Text>
				          </TouchableOpacity>
				        </View>
				      </Modal>
				    </View>);

				}"
			`);
    });
  });
});
