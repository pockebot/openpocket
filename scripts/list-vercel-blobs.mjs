import { list } from '@vercel/blob';

const token = process.env.BLOB_READ_WRITE_TOKEN;

if (!token) {
  console.error('Error: BLOB_READ_WRITE_TOKEN environment variable is required.');
  process.exit(1);
}

async function main() {
  try {
    console.log('Fetching blob list...');
    const { blobs } = await list({ token });
    
    if (blobs.length === 0) {
      console.log('No blobs found.');
      return;
    }

    console.log('\nFound the following blobs:');
    console.log('----------------------------------------');
    blobs.forEach(blob => {
      console.log(`Name: ${blob.pathname}`);
      console.log(`URL:  ${blob.url}`);
      console.log(`Size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      console.log('----------------------------------------');
    });
  } catch (error) {
    console.error('Error listing blobs:', error);
  }
}

main();
