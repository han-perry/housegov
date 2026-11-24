# HouseGov (govtracker V2)

Govtracker is the new, second generation website for Simmons Hall residents to propose new legislation and request funds from the house in a system called proposals. It does this with a presentation feature that is called when a  house meeting is called to order every two weeks.

The new system will have four primary functions - submitting proposals, conducting elections and referendums, managing documents, and running presentations.

## Infrastructure
- Infrastructure is handled using a library called membrane (Not completed yet) For now, assume the user has all permissions, but we will build an AuthZ connector later so build with this in mind.

## Ported Features
- Users with permission (`govtracker.propose`) can submit proposals, add secondary authors, title it, and add attachments.
    - Attachments are defined later but will affect how the constitution is amended. Funding requests are also considered attachments.
    - Most of the prompts should remain unchanged. It would be nice if the unofficial summary was limited to a certain number of words and the email sent out had a link to the full text of the proposal
- An email should be sent out from each proposal when it is submitted.
- The House Chair (or anyone with the permission `govtracker.manage`) can dismiss proposals (though they are still logged), and add them to the upcoming agenda.
    - To save space / delete offensive proposals, there should be an option to *delete* a proposal from the database.
- House chairs can add blocks of text/content to the agenda.
- Users should be able to search databse of (now paginated) proposals and view their status.
- Not sure here but it would be good to view house finances in the system somehow, though we don't need to host this here. Could put this in the *accounts* app in the future (see out of scope)
- Previous house meetingss should be documented and searchable


## **NEW** features
- All proposal text edit is not done with HTML tags, but with a rich text editor that accepts markdown. We don't have to build this ourselves if a good one exists in a library. We should also have a way to allow the house chair edit proposal text with rich text/markdown.
- Elections (see  Elections)
- Constitutional amendments are now in a section of the website for *policy* docs. This includes other policies like reservation policies. See govdocs to learn more.
- Instead of using the DB, we now create a "slideshow" (consider using a progamatic library like Remark) to build the slideshow from the proposals. The secretary or somebody with `govtracker.presentation` can open up a presentation console and type in notes/minutes with the slideshow.
    - The slideshow should have a little QR code that people at the meeting can scan for a live view of the slideshow on their mobile device. If the house chair needs to put something up to a vote, they can also call an *ad hoc* vote, which uses a "clicker"-esq system to get Yays/Nays using the live view, which are saved in the minutes.
- SSO authentication via OIDC. Not every page needs to be authenticated however (the @simmons-tech/auth package will have a configuration setting for this)
- Some kind of search function and pagination for old proposals would be nice, even if it requires some sort of indexing.
- It would be cool if the House Chair can "schedule a meeting" and the website displays a visual countdown (perhaps with a progress bar) of the time to the next meeting/time left to submit proposals for consideration. They can also set a proposal cutoff time, and a little box above the proposal will tell the submitter if it will be considered in this meeting or the next one.


## Out of scope
- We will move accounts to a new web app for accounts. Proposals should be able to be attached to an account (a proposal account, discretionary account, or a lounge account), but consider finances with the exception of creating a new account or modifying an account's funds out of scope.
- Much of the lounge details can be moved out of govtracker and into a new lounge management system, which we won't be designing here.
- Authentication is handled by OIDC, so don't build full auth here, unless you want to build a quick dev page to bootstrap permissions.

## NEW: ELECTIONS

- Previous elections/full-forum vote have been conducted via Google Forms or Qualtrics. I would like to move them to this website for security.
- Ballots can be public or secret. 
- Essentially, we will need to build some kind of timed form builder that accepts multiple types of questions.
    - Multiple Choice
    - Ranked Choice
    - Multi Select
    - Free form
- Most full-forum votes are yes-no, plus one comment section. Elections are currently done via ranked-choice + a write in option.
- As a stretch goal, I would like for candidate statements to be expandable from people's names so when building an election, the House Chair can attach a candidate statement below each person up for election. We can make the "ranked choice" question type a custom "vote" question type with options for ranked choice or pick 1. For ranked choice, we need only support ranked choice and instant runoff for now.
- Thus, this project involves building a simplified google forms. I would like for the House Chair to also check an option in the poll that displays the public results (a bar chart for each candidate next to each question). These charts are updated in real time
- For now, all polls allow people to change their vote before the deadline.
- Eventually, it would be nice for elections to automatically transfer group membership and orgcharts to the new people, but we don't need to worry about this for now.
- In vote tabluation, the house chair should be able to search ballots and exclude them from the vote count, but this should be publically accessible. A simple ui for this could be a table of vote ids and a checkbox with if they are included or not.
- For now, questions can be edited after they are submitted. This is assuming the House Chair will not do anything suspicious (flipping the Yay option to a Nay option after the fact). In practicality we may want to lock the ability to edit questions after votes have been cast.
- Votes for either candidates or questions otherwise can have approval thresholds which are displayed next to the question as a percentage.

## Ballots

As voters, people can submit a poll, edit their vote, or withdraw their vote up until the deadline. People can only vote *ONCE*.

Public ballots should be easy - a person's username is saved with their ballot, and is visible to the house chair. To validate if they are allowed to edit or view, just check if their username is the same username saved with the ballot.

Secret ballots are more complicated. We will develop a system that prevents people from voting twice, and editing/withdrawing other peoples' votes.

Thus, the first time someone votes, they are presented with a similar UI. However, when they submit their vote, the system instead stores a hash, known as the vote ID, (some hex number) associated with their vote with their ballot. To track their association with the ballot, we will use a second table that stores a hash of the vote ID + some code that they know. The server does NOT store the code (only it hashed with the vote ID), but both need to be known to associate the vote to the person.

After they cast their vote, the system will generate a code and email it to them along with their vote hash. That person can later "log in" with their vote ID and code to edit or delete their vote. 

To prevent someone from voting twice, the system can just check the values of the table (think keys and values) to see if their email is present. If a person thinks their code is compromised, they can log in with their vote ID and code, and ask to generate a new code. A new code will be emailed to them after authenticating them, and the table entry will be updated.

A public ledger should be shown with the ledger showing which vote ID voted for who. I don't know the best way to display this yet, so feel free to bounce some ideas.

## GovDocs

Previoulsy, the constitution and all policy docs were stored on html pages in the website. While this was fine, it made it hard to edit, track when the documents were edited, and see the revision history.

In this new version, I would like to use a subset of git features (made accessible through a web UI to non technical users) to edit the documents. This should be done fully on the website without anyone having to do a git push. Every document is tracked by its own git repository, so people can click on a previous version in the linear history and view the changes in a diff.

The process works as follows: A new page displays all govdocs (written in md). A user can click on a doc, and a "Propose an amendment" button is displayed. After clicking it, they are brought to the rich text/markdown editor with a copy of the document pre-populated for which they can make changes. Changes are autosaved to a *draft*, with a DIFF view beween the last version, until they submit it by attaching it to a proposal, then it becomes locked an unable to be deleted or edited.

A govdoc modification (a .patch file interally) can be an attachment to a proposal, in which the house chair can cause it to go into effect at a house meeting (the patch is applied when the user clicks the "approve" button), or attached to a full-forum vote (with an approval threshold), which they are automatically applied once the poll is closed.

Otherwise, the House Chair (and anyone with `govtracker.docs.manage`) permissions may edit and delete the amendment at any point in time from the UI. I think for simplicity, if the house votes on a motion to amend the woridng of an amendment in a meeting, the house chair just has a link to it in the presentation to the edit window. 

Merging the amendment to the document is done by rebasing the commit onto the history.

We need not worry about images for the time being, just text.

GovDocs should also have some kind of widget/iframe that exports them to some html/text that can be embedded to another website. If we need to do something even simpler, we can have some sort of .pdf endpoint that turns the current doc we're looking at to a pdf, and just embed that (after caching for performance).


## Stretch Goal: Discord bot

- I would like for HouseGov to use a Discord bot to send notices to a channel when new proposals are opened, and to create a discussion forum on each one. This should also apply to full-forum votes (and potentially elections). This will just be a one-way feed for now with links to the website to do stuff.

## Small thing: OrgChart

I would like to also have some kind of way to build an orgchart of housegov members and have expandable contact cards. For now, just include the usernames of everyone, and we will work on pulling personal details for V2

This should be editable (either by text or visual editor, but I have to imagine text is easier)

## Technology:
- For the presentation and the proposals, I would like these to be realtime, so ShareDB is a good option. Otherwise any database technology that is safe for user generated text is fine.
- The website should be pretty simplistic with a central menu theme of IBM Plex Sans and a grey menu bar at the top, and using bootstrap for styling for simplicity, with IBM Plex Serif for proposal/election/slideshow content
- Node.js + Express.js is fine and preferred for maintaniability
- If it makes sense to use some frontend framework, sure, but keep in mind we will need to support realtime edits and propagations.
- For now, bootstrap into my username (perryh) for testing purposes and give me all usernames. Assume that in the future we will have some kind of code that looks like the following:
```ts
if (user && user.hasPermission("govtracker.manage")) ...

//or 

enum GOVPERMS {
    MANAGE = "govtracker.manage"
}

if (user && user.hasPermission(GOVPERMS)) ...
```